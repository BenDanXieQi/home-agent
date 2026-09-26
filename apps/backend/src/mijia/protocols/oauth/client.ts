import { createHash, randomUUID } from "node:crypto";
import { CookieJar } from "tough-cookie";
import { z } from "zod";
import type { MiCloudSavedSession } from "../micloud/session";
import { MijiaError } from "../../errors";

const APP_ID = "2882303761520431603";
const ACCOUNT = "https://account.xiaomi.com";
const REDIRECT = "https://127.0.0.1";
const TOKEN_URL = "https://mico.api.mijia.tech/app/v2/mico/oauth/get_token";
export const oauthSessionSchema = z.strictObject({
  uuid: z.string().regex(/^[a-f0-9]{32}$/),
  accessToken: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192),
  expiresAt: z.number().finite().positive(),
});
const responseSchema = z.object({
  code: z.number(),
  data: z.unknown().optional(),
});
const confirmationSchema = z.object({
  pt: z.number(),
  device_id: z.string(),
  followup: z.string(),
  scope_id: z.string(),
  redirect_uri: z.literal(REDIRECT),
  client_id: z.literal(APP_ID),
  _ssign: z.string().min(1),
});

// Never let supplier URLs, response bodies or credentials escape as error messages.
async function request(url: URL, init: RequestInit, signal: AbortSignal) {
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal });
    const text = await response.text();
    if (response.status === 401 || response.status === 403)
      throw new MijiaError("authentication");
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const at =
        retry && /^\d+$/.test(retry)
          ? Date.now() + Number(retry) * 1000
          : Date.parse(retry ?? "");
      throw new MijiaError(
        "network",
        Number.isFinite(at)
          ? { retry_after_at: new Date(at).toISOString() }
          : undefined,
      );
    }
    if (response.status >= 500) throw new MijiaError("network");
    if (response.status >= 400) throw new MijiaError("cloud_invalid_response");
    return { response, text };
  } catch (error) {
    if (error instanceof MijiaError) throw error;
    if (signal.aborted) signal.throwIfAborted();
    throw new MijiaError("network");
  }
}
function decode(text: string) {
  try {
    // These application IDs are larger than Number.MAX_SAFE_INTEGER.
    return JSON.parse(
      text
        .replace(/^&&&START&&&/, "")
        .replace(/("client_id"\s*:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"'),
    ) as unknown;
  } catch {
    throw new MijiaError("cloud_invalid_response");
  }
}
function accountUrl(value: string, paths: readonly string[]) {
  const url = new URL(value, ACCOUNT);
  if (
    url.origin !== ACCOUNT ||
    url.username ||
    url.password ||
    !paths.includes(url.pathname)
  )
    throw new MijiaError("cloud_invalid_response");
  return url;
}
async function exchange(
  uuid: string,
  grant: { code: string; device_id: string } | { refresh_token: string },
  signal: AbortSignal,
) {
  const url = new URL(TOKEN_URL);
  url.searchParams.set(
    "data",
    JSON.stringify({ client_id: APP_ID, redirect_uri: REDIRECT, ...grant }),
  );
  const startedAt = Date.now();
  const { text, response } = await request(url, {}, signal);
  if (response.status !== 200) throw new MijiaError("cloud_invalid_response");
  const parsed = z
    .object({
      code: z.number(),
      result: z
        .object({
          access_token: z.string().min(1),
          refresh_token: z.string().min(1),
          expires_in: z.number().positive().max(31_536_000),
        })
        .optional(),
    })
    .safeParse(decode(text));
  if (!parsed.success) throw new MijiaError("cloud_invalid_response");
  if (parsed.data.code !== 0 || !parsed.data.result)
    throw new MijiaError("authentication");
  const token = parsed.data.result;
  return oauthSessionSchema.parse({
    uuid,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: startedAt + token.expires_in * 1000,
  });
}

export async function refreshOAuth(
  session: z.infer<typeof oauthSessionSchema>,
  signal: AbortSignal,
  force = false,
) {
  if (!force && session.expiresAt > Date.now() + 5 * 60_000) return session;
  return exchange(
    session.uuid,
    { refresh_token: session.refreshToken },
    AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  );
}

/** Completes the authorization included in the single QR login flow. */
export async function authorizeOAuth(
  session: MiCloudSavedSession,
  parent: AbortSignal,
) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(60_000)]);
  const uuid = randomUUID().replaceAll("-", "");
  const deviceId = `mico.${uuid}`;
  const state = createHash("sha1").update(`d=${deviceId}`).digest("hex");
  const jar = new CookieJar();
  const start = new URL(`${ACCOUNT}/oauth2/authorize`);
  start.search = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    device_id: deviceId,
    state,
    skip_confirm: "false",
  }).toString();
  const send = async (url: URL, raw = false, body?: URLSearchParams) => {
    accountUrl(url.href, [
      "/oauth2/authorize",
      "/pass/serviceLogin",
      "/sts/oauth",
      "/oauth2/userAuthorization",
    ]);
    if (
      raw &&
      !["/oauth2/authorize", "/pass/serviceLogin"].includes(url.pathname)
    )
      throw new MijiaError("cloud_invalid_response");
    const result = await request(
      url,
      {
        method: body ? "POST" : "GET",
        body,
        headers: {
          "User-Agent": session.userAgent,
          Cookie: raw
            ? `userId=${session.userId}; passToken=${session.passToken}`
            : jar.getCookieStringSync(url.href),
          ...(body
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                Origin: ACCOUNT,
                Referer: start.href,
              }
            : {}),
        },
      },
      signal,
    );
    if (!raw)
      for (const cookie of result.response.headers.getSetCookie())
        jar.setCookieSync(cookie, url.href);
    return result;
  };
  let url = start;
  for (const [index, nextPath] of [
    "/pass/serviceLogin",
    "/sts/oauth",
    "/oauth2/authorize",
  ].entries()) {
    const { response } = await send(url, index < 2);
    const location = response.headers.get("location");
    if (response.status !== 302 || !location)
      throw new MijiaError("authentication");
    url = accountUrl(location, [nextPath]);
  }
  url.searchParams.set("_json", "true");
  const page = responseSchema.parse(decode((await send(url)).text));
  if (page.code !== 0) throw new MijiaError("authentication");
  const parameters = confirmationSchema.parse(page.data);
  const continuation = accountUrl(parameters.followup, ["/oauth2/authorize"]);
  if (
    continuation.searchParams.get("device_id") !== deviceId ||
    continuation.searchParams.get("state") !== state
  )
    throw new MijiaError("cloud_invalid_response");
  const body = new URLSearchParams({ _json: "true" });
  for (const [key, value] of Object.entries(parameters))
    body.set(key, String(value));
  const consent = responseSchema.parse(
    decode(
      (await send(new URL(`${ACCOUNT}/oauth2/userAuthorization`), false, body))
        .text,
    ),
  );
  if (consent.code !== 0) throw new MijiaError("authentication");
  const followup = z
    .object({ followup: z.string() })
    .parse(consent.data).followup;
  url = accountUrl(followup, ["/oauth2/authorize"]);
  url.searchParams.delete("_json");
  const { response } = await send(url);
  const location = response.headers.get("location");
  if (response.status !== 302 || !location)
    throw new MijiaError("cloud_invalid_response");
  const callback = new URL(location);
  const code = callback.searchParams.get("code");
  if (
    callback.origin !== REDIRECT ||
    callback.pathname !== "/" ||
    callback.searchParams.get("state") !== state ||
    !code
  )
    throw new MijiaError("authentication");
  return exchange(uuid, { code, device_id: deviceId }, signal);
}
