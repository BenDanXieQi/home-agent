// Adapted from homebridge-miot/lib/protocol/MiCloud.js at the commit in ../README.md.
// Copyright (c) 2025 Marcin. MIT license; see ../LICENSE.
import { createHash, randomInt, randomBytes } from "node:crypto";
import { z } from "zod";
import { MiCloudError } from "./errors";
import { readHomes, deviceLocations, type DeviceLocation } from "./homes";
import { cryptRc4 } from "./rc4";
import { savedSessionSchema, type MiCloudSavedSession } from "./session";
import {
  MiCloudTransport,
  trustedUrl,
  type RequestOptions,
  type RequestStartObserver,
} from "./transport";
import {
  MIOT_PROPERTY_BATCH_SIZE,
  MIOT_PROPERTY_TIMEOUT_MS,
  miotPropertyAddressSchema,
  type MiotPropertyAddress,
} from "./properties";

export type { MiCloudSavedSession } from "./session";

export type MiCloudRegion = MiCloudSavedSession["region"];

/** Server-only raw data. Project a field whitelist before returning devices to a browser. */
export interface MiCloudDevice extends Partial<DeviceLocation> {
  did: string;
  name?: string;
  model?: string;
  isOnline?: boolean;
  spec_type?: string;
  [key: string]: unknown;
}

/** Server-only credentials for the camera adapter. Never serialize into API responses. */
export type MiCloudCredentials = ReturnType<MiCloud["getCredentials"]>;

const objectSchema = z.looseObject({});
type JsonObject = z.infer<typeof objectSchema>;
type Session = Pick<MiCloudSavedSession, "ssecurity" | "userId" | "passToken">;
const ACCOUNT_URL = "https://account.xiaomi.com";
const STS_URL = "https://sts.api.io.mi.com/sts";
const DEVICE_URL = "https://api.io.mi.com/app/home/device_list";

function object(value: unknown) {
  const parsed = objectSchema.safeParse(value);
  if (!parsed.success) {
    throw new MiCloudError("invalid-response");
  }
  return parsed.data;
}

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function identifier(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
  return text(value);
}

function parseJson(content: string) {
  try {
    let source = content.replace(/^&&&START&&&/, "");
    const jsonp = source.match(/^[A-Za-z_$][\w.$]*\s*\((.*)\);?$/s);
    if (jsonp?.[1]) source = jsonp[1];
    const value: unknown = JSON.parse(source);
    return object(value);
  } catch {
    throw new MiCloudError("invalid-response");
  }
}

function randomCharacters(length: number, characters: string) {
  return Array.from(
    { length },
    () => characters[randomInt(characters.length)]!,
  ).join("");
}

function seconds(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

/** Owns one cloud identity; renewal returns an isolated candidate for durable adoption. */
export class MiCloud {
  readonly region: MiCloudRegion;
  #identity = {
    clientId: randomCharacters(
      6,
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    ).toUpperCase(),
    userAgent: `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${randomCharacters(13, "ABCDEF")} APP/com.xiaomi.mihome APPV/10.5.201`,
  };
  #transport = new MiCloudTransport(this.#identity, (pragma) =>
    this.#captureCredentials(parseJson(pragma)),
  );
  #session: Session | undefined;
  #serviceToken: { value: string; expiresAt: number | null } | undefined;
  #pendingCredentials: Partial<Session> = {};
  #pollUrl: string | undefined;
  #verificationUrl: string | undefined;
  #expiresAt = 0;
  #started = false;
  #busy = false;

  constructor(options: { region?: MiCloudRegion } = {}) {
    if (options.region !== undefined && options.region !== "cn") {
      throw new MiCloudError("unsupported-region");
    }
    this.region = "cn";
  }

  async createLogin(signal?: AbortSignal) {
    this.#transport.assertActive(signal);
    if (this.#started) throw new MiCloudError("invalid-state");
    this.#started = true;
    const url = new URL(`${ACCOUNT_URL}/longPolling/loginUrl`);
    url.search = new URLSearchParams({
      _qrsize: "480",
      qs: "?sid=xiaomiio&_json=true",
      callback: STS_URL,
      _hasLogo: "false",
      sid: "xiaomiio",
      serviceParam: "",
      _locale: "zh_CN",
      _dc: String(Date.now()),
    }).toString();
    const data = await this.#requestJson(url, {}, signal);
    const qrUrl = text(data.qr);
    const pollUrl = text(data.lp);
    if (!qrUrl || !pollUrl) throw new MiCloudError("invalid-response");
    this.#pollUrl = trustedUrl(pollUrl).toString();
    this.#expiresAt = Date.now() + seconds(data.timeout, 300, 1, 600) * 1000;
    const qr = await this.#transport.request(trustedUrl(qrUrl), {}, signal);
    const mime = qr.headers.get("content-type")?.split(";")[0]?.trim();
    if (mime !== "image/png" && mime !== "image/jpeg") {
      throw new MiCloudError("invalid-response");
    }
    this.#assertLoginActive(signal);
    return {
      qrImage: `data:${mime};base64,${qr.body.toString("base64")}`,
      expiresAt: this.#expiresAt,
      pollIntervalMs: seconds(data.timeInterval, 3, 2, 10) * 1000,
    };
  }

  async pollLogin(signal?: AbortSignal) {
    this.#transport.assertActive(signal);
    if (this.#session) return { status: "authenticated" as const };
    if (!this.#pollUrl) throw new MiCloudError("invalid-state");
    if (Date.now() >= this.#expiresAt) return this.#expire();
    if (this.#verificationUrl) {
      return {
        status: "security-required" as const,
        verificationUrl: this.#verificationUrl,
      };
    }
    if (this.#busy) throw new MiCloudError("invalid-state");
    this.#busy = true;
    try {
      const url = trustedUrl(this.#pollUrl);
      url.searchParams.set("_", String(Date.now()));
      const data = await this.#requestJson(
        url,
        {},
        signal,
        Math.min(30_000, this.#expiresAt - Date.now()),
      );
      this.#assertLoginActive(signal);
      this.#captureCredentials(data);
      if (data.notificationUrl)
        return this.#requireSecurity(data.notificationUrl);
      if (data.ssecurity && data.userId && data.location) {
        const status = await this.#completeSession(text(data.location), signal);
        return status;
      }
      if (data.ssecurity || data.userId || data.passToken || data.location) {
        throw new MiCloudError("missing-credentials");
      }
      // Upstream keeps non-completed long-poll responses pending until the QR session's deadline.
      return { status: "pending" as const };
    } catch (error) {
      if (error instanceof MiCloudError && error.code === "expired")
        return this.#expire();
      if (error instanceof MiCloudError && error.code === "timeout") {
        if (Date.now() >= this.#expiresAt) return this.#expire();
        return { status: "pending" as const };
      }
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  /** Submit the SMS/email code requested by Xiaomi's verification page, never an account token. */
  async submitSecurityCode(code: string, signal?: AbortSignal) {
    this.#assertLoginActive(signal);
    if (!this.#verificationUrl || this.#busy)
      throw new MiCloudError("invalid-state");
    if (!/^[0-9]{4,10}$/.test(code))
      throw new MiCloudError("security-code-invalid");
    this.#busy = true;
    try {
      const path = "fe/service/identity/authStart";
      if (!this.#verificationUrl.includes(path))
        throw new MiCloudError("unsupported-security");
      const listUrl = trustedUrl(
        this.#verificationUrl.replace(path, "identity/list"),
      );
      const list = await this.#requestJson(listUrl, {}, signal);
      const flag = list.flag === undefined ? 4 : Number(list.flag);
      const endpoint =
        flag === 4 ? "verifyPhone" : flag === 8 ? "verifyEmail" : undefined;
      if (!endpoint) throw new MiCloudError("unsupported-security");
      const url = new URL(`${ACCOUNT_URL}/identity/auth/${endpoint}`);
      url.searchParams.set("_dc", String(Date.now()));
      if (!this.#transport.cookie("identity_session", url)?.value)
        throw new MiCloudError("invalid-response");
      const data = await this.#requestJson(
        url,
        {
          method: "POST",
          sameOriginRedirects: true,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            Accept: "application/json",
            "x-requested-with": "XMLHttpRequest",
          },
          body: new URLSearchParams({
            ticket: code,
            trust: "true",
            _json: "true",
            _flag: String(flag),
          }),
        },
        signal,
      );
      this.#assertLoginActive(signal);
      if (Number(data.code) !== 0 || !text(data.location))
        throw new MiCloudError("security-code-invalid");
      this.#captureCredentials(data);
      this.#verificationUrl = undefined;
      return await this.#completeSession(text(data.location), signal);
    } finally {
      this.#busy = false;
    }
  }

  exportSession() {
    this.#transport.assertActive();
    if (!this.#session || !this.#serviceToken)
      throw new MiCloudError("authentication");
    const result = savedSessionSchema.safeParse({
      ...this.#session,
      region: this.region,
      serviceToken: this.#serviceToken.value,
      expiresAt: this.#serviceToken.expiresAt,
      ...this.#identity,
    });
    if (!result.success) throw new MiCloudError("invalid-response");
    return result.data;
  }

  static restoreSession(value: unknown) {
    const result = savedSessionSchema.safeParse(value);
    if (!result.success) throw new MiCloudError("invalid-session");
    const saved = result.data;
    const cloud = new MiCloud({ region: saved.region });
    cloud.#identity.clientId = saved.clientId;
    cloud.#identity.userAgent = saved.userAgent;
    cloud.#installSession(
      saved,
      saved.serviceToken,
      saved.expiresAt === null ? "Infinity" : new Date(saved.expiresAt),
    );
    return cloud;
  }

  /** Exchange the current passToken without mutating the active device session. */
  async renewSession(signal?: AbortSignal) {
    this.#transport.assertActive(signal);
    const saved = this.exportSession();
    const candidate = new MiCloud({ region: saved.region });
    candidate.#identity.clientId = saved.clientId;
    candidate.#identity.userAgent = saved.userAgent;
    const renewalSignal = AbortSignal.any([
      this.#transport.signal,
      ...(signal ? [signal] : []),
    ]);
    try {
      const url = new URL(`${ACCOUNT_URL}/pass/serviceLogin`);
      url.search = new URLSearchParams({
        _json: "true",
        sid: "xiaomiio",
      }).toString();
      candidate.#pendingCredentials = {
        userId: saved.userId,
        passToken: saved.passToken,
      };
      for (const name of ["userId", "passToken"] as const)
        candidate.#transport.setCookie(name, saved[name], url.toString(), {
          path: "/pass",
        });
      const data = await candidate.#requestJson(url, {}, renewalSignal);
      if (
        data.notificationUrl ||
        (data.code !== undefined && Number(data.code) !== 0)
      )
        throw new MiCloudError("authentication");
      if (!text(data.location) || !text(data.ssecurity))
        throw new MiCloudError("invalid-response");
      candidate.#captureCredentials(data);
      candidate.#pendingCredentials.passToken =
        text(data.passToken) ??
        candidate.#transport.cookie("passToken", url)?.value ??
        saved.passToken;
      if (candidate.#pendingCredentials.userId !== saved.userId)
        throw new MiCloudError("authentication");
      await candidate.#completeSession(
        text(data.location),
        renewalSignal,
        saved.userId,
      );
      this.#transport.assertActive(signal);
      return candidate;
    } catch (error) {
      candidate.dispose();
      throw error;
    }
  }

  #installSession(
    session: Session,
    serviceToken: string,
    expires: Date | "Infinity",
  ) {
    this.#transport.clearCookies();
    for (const [name, value] of Object.entries({
      userId: session.userId,
      serviceToken,
      yetAnotherServiceToken: serviceToken,
      locale: "zh_CN",
      channel: "MI_APP_STORE",
    })) {
      this.#transport.setCookie(name, value, DEVICE_URL, {
        path: "/app",
        expires,
      });
    }
    this.#session = {
      userId: session.userId,
      passToken: session.passToken,
      ssecurity: session.ssecurity,
    };
    this.#serviceToken = {
      value: serviceToken,
      expiresAt: expires === "Infinity" ? null : expires.getTime(),
    };
  }

  getCredentials() {
    this.#transport.assertActive();
    if (!this.#session) throw new MiCloudError("missing-credentials");
    return {
      userId: this.#session.userId,
      passToken: this.#session.passToken,
      region: this.region,
    };
  }

  async getProfile(signal?: AbortSignal) {
    const { userId } = this.getCredentials();
    const url = new URL("https://api.account.xiaomi.com/pass/usersCard");
    url.searchParams.set("ids", userId);
    const response = z
      .object({
        code: z.literal(0),
        data: z.object({
          list: z.array(
            z.object({
              userId: z
                .union([z.string(), z.number().int().safe()])
                .transform(String),
              miliaoNick: z.string(),
              miliaoIcon: z.string(),
            }),
          ),
        }),
      })
      .safeParse(await this.#requestJson(url, {}, signal, 10_000));
    if (!response.success) throw new MiCloudError("invalid-response");
    const profile = response.data.data.list.find(
      (item) => item.userId === userId,
    );
    if (!profile) throw new MiCloudError("invalid-response");
    const avatar = z
      .url({ protocol: /^https?$/ })
      .safeParse(profile.miliaoIcon);
    return {
      name: profile.miliaoNick.trim() || null,
      avatarUrl: avatar.success
        ? avatar.data.replace(/^http:/, "https:")
        : null,
    };
  }

  getHomes(signal?: AbortSignal) {
    return readHomes(
      (path, data, requestSignal) =>
        this.#deviceRequest(path, data, requestSignal),
      AbortSignal.any([
        this.#transport.signal,
        AbortSignal.timeout(30_000),
        ...(signal ? [signal] : []),
      ]),
    );
  }

  async getCatalog(signal?: AbortSignal) {
    const requestSignal = AbortSignal.any([
      this.#transport.signal,
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]);
    const homes = await this.getHomes(requestSignal);
    const locations = deviceLocations(homes);
    const ids = [...locations.keys()];
    const devices: MiCloudDevice[] = [];
    // Account-wide device_list omits shared-home devices. Resolve the explicit
    // membership IDs through the paged detail endpoint used by Xiaomi Home.
    for (let offset = 0; offset < ids.length; offset += 150) {
      const batch = ids.slice(offset, offset + 150);
      const requested = new Set(batch);
      const found = new Map<string, MiCloudDevice>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const result = object(
          await this.#deviceRequest(
            "/v2/home/device_list_page",
            {
              limit: 200,
              get_split_device: true,
              get_third_device: true,
              dids: batch,
              ...(cursor ? { start_did: cursor } : {}),
            },
            requestSignal,
          ),
        );
        if (
          !Array.isArray(result.list) ||
          (result.has_more !== undefined &&
            typeof result.has_more !== "boolean")
        )
          throw new MiCloudError("invalid-response");
        for (const item of result.list) {
          const device = object(item);
          const did = identifier(device.did);
          if (!did) throw new MiCloudError("invalid-response");
          if (!requested.has(did)) continue;
          found.set(did, {
            ...device,
            did,
            ...locations.get(did),
          });
        }
        if (!result.has_more) break;
        cursor = identifier(result.next_start_did);
        if (!cursor || cursors.has(cursor) || cursors.size >= 100)
          throw new MiCloudError("invalid-response");
        cursors.add(cursor);
      }
      devices.push(...found.values());
    }
    this.#transport.assertActive(requestSignal);
    return { homes, devices };
  }

  /** One batch over this account's existing RC4 session; scheduling belongs to properties/. */
  async getProperties(
    properties: readonly MiotPropertyAddress[],
    signal?: AbortSignal,
    onRequestStarted?: RequestStartObserver,
  ) {
    this.#transport.assertActive(signal);
    if (
      properties.length > MIOT_PROPERTY_BATCH_SIZE ||
      !miotPropertyAddressSchema.array().safeParse(properties).success
    )
      throw new MiCloudError("invalid-input");
    if (properties.length === 0) return [];
    // Xiaomi SDK: datasource=1 prefers cached values and can use RPC on a cache miss.
    // https://github.com/MiEcosystem/miot-plugin-sdk/wiki/04-miot_spec
    const result = await this.#deviceRequest(
      "/miotspec/prop/get",
      {
        datasource: 1,
        params: properties.map(({ did, siid, piid }) => ({ did, siid, piid })),
      },
      signal,
      MIOT_PROPERTY_TIMEOUT_MS,
      onRequestStarted,
    );
    const parsed = z.array(z.unknown()).safeParse(result);
    if (!parsed.success) throw new MiCloudError("invalid-response");
    return parsed.data;
  }

  async #deviceRequest(
    path: string,
    data: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
    onRequestStarted?: RequestStartObserver,
  ) {
    this.#transport.assertActive(signal);
    const session = this.#session;
    if (!session || !this.#transport.cookie("serviceToken", DEVICE_URL))
      throw new MiCloudError("authentication");
    const url = new URL(`/app${path}`, DEVICE_URL);
    const nonceBytes = Buffer.alloc(12);
    randomBytes(8).copy(nonceBytes);
    nonceBytes.writeInt32BE(Math.floor(Date.now() / 60_000), 8);
    const nonce = nonceBytes.toString("base64");
    const key = createHash("sha256")
      .update(Buffer.from(session.ssecurity, "base64"))
      .update(nonceBytes)
      .digest();
    const params: Record<string, string> = {
      data: JSON.stringify(data),
    };
    const signature = () =>
      createHash("sha1")
        .update(
          [
            "POST",
            path,
            ...Object.keys(params)
              .toSorted()
              .map((name) => `${name}=${params[name]}`),
            key.toString("base64"),
          ].join("&"),
        )
        .digest("base64");
    params["rc4_hash__"] = signature();
    for (const [name, value] of Object.entries(params)) {
      params[name] = cryptRc4(key, Buffer.from(value)).toString("base64");
    }
    params.signature = signature();
    params.ssecurity = session.ssecurity;
    params["_nonce"] = nonce;
    const response = await this.#transport.request(
      url,
      {
        method: "POST",
        headers: {
          "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
          "Accept-Encoding": "identity",
          "Content-Type": "application/x-www-form-urlencoded",
          "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4",
        },
        body: new URLSearchParams(params),
      },
      signal,
      timeoutMs,
      onRequestStarted,
    );
    const encrypted = response.body.toString("utf8");
    // An unencrypted authentication error must not be decoded as device data.
    if (encrypted.trimStart().startsWith("{")) {
      const error = parseJson(encrypted);
      const upstreamCode =
        typeof error.code === "number" && Number.isSafeInteger(error.code)
          ? error.code
          : undefined;
      const details = upstreamCode === undefined ? {} : { upstreamCode };
      if (upstreamCode === -3 || upstreamCode === 3)
        throw new MiCloudError("authentication", details);
      throw new MiCloudError("invalid-response", details);
    }
    const result = parseJson(
      cryptRc4(key, Buffer.from(encrypted, "base64")).toString("utf8"),
    );
    const upstreamCode =
      typeof result.code === "number" && Number.isSafeInteger(result.code)
        ? result.code
        : undefined;
    const details = upstreamCode === undefined ? {} : { upstreamCode };
    if (upstreamCode === -3 || upstreamCode === 3)
      throw new MiCloudError("authentication", details);
    if (upstreamCode !== 0) throw new MiCloudError("invalid-response", details);
    this.#transport.assertActive(signal);
    return result.result;
  }

  dispose() {
    this.#transport.dispose();
    this.#session = undefined;
    this.#serviceToken = undefined;
    this.#pendingCredentials = {};
    this.#pollUrl = undefined;
    this.#verificationUrl = undefined;
  }

  #assertLoginActive(signal?: AbortSignal) {
    this.#transport.assertActive(signal);
    if (!this.#started) throw new MiCloudError("invalid-state");
    if (Date.now() >= this.#expiresAt) throw new MiCloudError("expired");
  }

  #expire() {
    this.#transport.clearCookies();
    this.#pendingCredentials = {};
    this.#verificationUrl = undefined;
    return { status: "expired" as const };
  }

  #requireSecurity(value: unknown) {
    const verificationUrl = text(value);
    if (!verificationUrl) throw new MiCloudError("invalid-response");
    const url = trustedUrl(verificationUrl, ACCOUNT_URL);
    if (url.hostname !== "account.xiaomi.com")
      throw new MiCloudError("unsupported-security");
    this.#verificationUrl = url.toString();
    return {
      status: "security-required" as const,
      verificationUrl: this.#verificationUrl,
    };
  }

  #captureCredentials(data: JsonObject) {
    const userId = identifier(data.userId);
    const ssecurity = text(data.ssecurity);
    const passToken = text(data.passToken);
    if (userId) this.#pendingCredentials.userId = userId;
    if (ssecurity) this.#pendingCredentials.ssecurity = ssecurity;
    if (passToken) this.#pendingCredentials.passToken = passToken;
    const cUserId = text(data.cUserId);
    if (cUserId) {
      this.#transport.setCookie("cUserId", cUserId, STS_URL, {
        domain: "mi.com",
      });
    }
  }

  async #completeSession(
    location: string | undefined,
    signal?: AbortSignal,
    renewingUserId?: string,
  ) {
    if (!location) throw new MiCloudError("invalid-response");
    const transferredPassToken = this.#pendingCredentials.passToken;
    // QR returns account cookies in the response body; carry them into this same login's STS exchange.
    for (const name of ["userId", "passToken"] as const) {
      const value = this.#pendingCredentials[name];
      if (value)
        this.#transport.setCookie(name, value, STS_URL, { domain: "mi.com" });
    }
    const response = await this.#transport.request(
      trustedUrl(location),
      {},
      signal,
    );
    const body = response.body.toString("utf8");
    if (renewingUserId) this.#transport.assertActive(signal);
    else this.#assertLoginActive(signal);
    if (body.startsWith("&&&START&&&") || body.trimStart().startsWith("{")) {
      const data = parseJson(body);
      this.#captureCredentials(data);
      if (data.notificationUrl && renewingUserId)
        throw new MiCloudError("authentication");
      if (data.notificationUrl)
        return this.#requireSecurity(data.notificationUrl);
    }
    const credentialUrl = trustedUrl(response.url);
    const ssecurity = this.#pendingCredentials.ssecurity;
    const cookieUserId = this.#transport.cookie("userId", credentialUrl)?.value;
    if (renewingUserId && cookieUserId && cookieUserId !== renewingUserId)
      throw new MiCloudError("authentication");
    const userId = this.#pendingCredentials.userId || cookieUserId;
    const cookiePassToken = this.#transport.cookie(
      "passToken",
      credentialUrl,
    )?.value;
    // An unchanged transfer cookie must not mask credentials rotated by the
    // response body or login pragma during the STS exchange.
    const passToken =
      cookiePassToken && cookiePassToken !== transferredPassToken
        ? cookiePassToken
        : (this.#pendingCredentials.passToken ?? cookiePassToken);
    const serviceCookie = this.#transport.cookie("serviceToken", credentialUrl);
    const serviceToken = serviceCookie?.value;
    if (renewingUserId && userId !== renewingUserId)
      throw new MiCloudError("authentication");
    if (
      !ssecurity ||
      !userId ||
      !passToken ||
      !serviceToken ||
      !serviceCookie
    ) {
      throw new MiCloudError("missing-credentials");
    }
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(ssecurity) ||
      /[;\r\n]/.test(userId + passToken + serviceToken)
    ) {
      throw new MiCloudError("invalid-response");
    }
    // The protocol transfers the STS token to the device API. Preserve its
    // absolute expiry while narrowing cookies to this API host and path.
    const expiryTime = serviceCookie.expiryTime();
    const expires =
      expiryTime !== undefined && Number.isFinite(expiryTime)
        ? new Date(expiryTime)
        : "Infinity";
    if (expires !== "Infinity" && expires.getTime() <= Date.now())
      throw new MiCloudError("authentication");
    this.#installSession(
      { ssecurity, userId, passToken },
      serviceToken,
      expires,
    );
    this.#pendingCredentials = {};
    this.#pollUrl = undefined;
    this.#verificationUrl = undefined;
    return { status: "authenticated" as const };
  }

  async #requestJson(
    url: URL,
    options: RequestOptions,
    signal?: AbortSignal,
    timeoutMs?: number,
  ) {
    const response = await this.#transport.request(
      url,
      options,
      signal,
      timeoutMs,
    );
    return parseJson(response.body.toString("utf8"));
  }
}
