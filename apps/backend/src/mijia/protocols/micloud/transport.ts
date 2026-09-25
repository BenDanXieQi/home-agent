import {
  readLimitedBytes,
  ResponseBodyError,
} from "@home-agent/api/http/read-body";
import { parseRetryAfter } from "@home-agent/api/http/retry-after";
// Adapted from homebridge-miot/lib/protocol/MiCloud.js; source and MIT license in ../README.md.
// Copyright (c) 2025 Marcin.
import { Cookie, CookieJar } from "tough-cookie";
import { MiCloudError } from "./errors";
import type { MiCloudSavedSession } from "./session";

// Xiaomi redirects can replay form bodies on 307/308 responses.
export type RequestOptions = Omit<RequestInit, "body"> & {
  body?: URLSearchParams;
  sameOriginRedirects?: boolean;
};
/** Reports the first fetch dispatch, after local request preparation has succeeded. */
export type RequestStartObserver = (startedAt: string) => void;
type Identity = Pick<MiCloudSavedSession, "clientId" | "userAgent">;
type CookieOptions = {
  domain?: string;
  path?: string;
  expires?: Date | "Infinity";
};
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function trustedUrl(value: string, base?: string) {
  try {
    const url = new URL(value, base);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !["xiaomi.com", "mi.com"].some(
        (domain) =>
          url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    )
      throw new MiCloudError("invalid-response");
    return url;
  } catch {
    throw new MiCloudError("invalid-response");
  }
}

/** Owns one account's cookies and requests; returned bodies are fully consumed. */
export class MiCloudTransport {
  #controller = new AbortController();
  #cookies = new CookieJar();
  #cookieWrites = new Map<string, number>();
  #cookieWriteSequence = 0;

  constructor(
    private readonly identity: Readonly<Identity>,
    private readonly onLoginPragma: (value: string) => void,
  ) {}

  get signal() {
    return this.#controller.signal;
  }

  assertActive(signal?: AbortSignal) {
    if (this.#controller.signal.aborted) throw new MiCloudError("cancelled");
    if (signal?.aborted)
      throw new MiCloudError(
        signal.reason instanceof DOMException &&
          signal.reason.name === "TimeoutError"
          ? "timeout"
          : "cancelled",
      );
  }

  clearCookies() {
    this.#cookies.removeAllCookiesSync();
    this.#cookieWrites.clear();
    this.#cookieWriteSequence = 0;
  }

  dispose() {
    this.#controller.abort();
    this.clearCookies();
  }

  cookie(name: string, url: URL | string) {
    return (
      this.#cookies
        .getCookiesSync(url.toString())
        .filter((cookie) => cookie.key === name)
        // Protocol credential extraction uses the latest matching write. Jar
        // ordering can put a seeded token before its rotated value in another scope.
        .toSorted(
          (a, b) =>
            (this.#cookieWrites.get(this.#cookieKey(b)) ?? 0) -
            (this.#cookieWrites.get(this.#cookieKey(a)) ?? 0),
        )[0]
    );
  }

  #cookieKey(cookie: Cookie) {
    return JSON.stringify([cookie.domain, cookie.path, cookie.key]);
  }

  #recordCookieWrite(cookie: Cookie | undefined) {
    if (cookie)
      this.#cookieWrites.set(
        this.#cookieKey(cookie),
        ++this.#cookieWriteSequence,
      );
  }

  setCookie(key: string, value: string, url: string, options: CookieOptions) {
    // JSON credentials are protocol values, not Set-Cookie header strings.
    if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(value))
      throw new MiCloudError("invalid-response");
    try {
      const cookie = this.#cookies.setCookieSync(
        new Cookie({ key, value, path: "/", secure: true, ...options }),
        url,
      );
      this.#recordCookieWrite(cookie);
    } catch {
      throw new MiCloudError("invalid-response");
    }
  }

  async request(
    url: URL,
    options: RequestOptions,
    signal?: AbortSignal,
    timeoutMs = 15_000,
    onRequestStarted?: RequestStartObserver,
  ) {
    this.assertActive(signal);
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
    const requestSignal = AbortSignal.any([
      this.#controller.signal,
      timeout,
      ...(signal ? [signal] : []),
    ]);
    let next = trustedUrl(url.toString());
    let pendingResponse: Response | undefined;
    try {
      for (let hop = 0; hop < 10; hop++) {
        const { sameOriginRedirects, ...requestOptions } = options;
        const headers = new Headers(options.headers);
        headers.set("User-Agent", this.identity.userAgent);
        headers.set("Cookie", this.#cookieHeader(next));
        requestSignal.throwIfAborted();
        if (hop === 0) onRequestStarted?.(new Date().toISOString());
        const response = await fetch(next, {
          ...requestOptions,
          headers,
          signal: requestSignal,
          redirect: "manual",
        });
        pendingResponse = response;
        requestSignal.throwIfAborted();
        this.#storeCookies(response, next);
        const pragma = response.headers.get("extension-pragma");
        if (pragma) this.onLoginPragma(pragma);
        const location = response.headers.get("location");
        if ([301, 302, 303, 307, 308].includes(response.status) && location) {
          await response.body?.cancel();
          const destination = trustedUrl(location, next.toString());
          if (sameOriginRedirects && destination.origin !== url.origin)
            throw new MiCloudError("invalid-response");
          options = redirectOptions(
            options,
            response.status,
            next,
            destination,
          );
          next = destination;
          continue;
        }
        if (!response.ok) {
          const now = Date.now();
          const retryDelay = parseRetryAfter(
            response.headers.get("retry-after"),
            now,
          );
          const retryAt =
            retryDelay === undefined ? undefined : now + retryDelay;
          throw new MiCloudError(
            response.status === 401 || response.status === 403
              ? "authentication"
              : response.status === 408 ||
                  response.status === 429 ||
                  response.status >= 500
                ? "network"
                : "invalid-response",
            {
              httpStatus: response.status,
              ...(retryAt !== undefined &&
              Number.isSafeInteger(retryAt) &&
              retryAt <= 8_640_000_000_000_000
                ? { retryAfterAt: retryAt }
                : {}),
            },
          );
        }
        const body = Buffer.from(
          await readLimitedBytes(response, MAX_RESPONSE_BYTES, requestSignal),
        );
        return { url: response.url, headers: response.headers, body };
      }
      throw new MiCloudError("invalid-response");
    } catch (error) {
      await pendingResponse?.body?.cancel().catch(() => {});
      if (requestSignal.aborted)
        throw new MiCloudError(
          requestSignal.reason instanceof DOMException &&
            requestSignal.reason.name === "TimeoutError"
            ? "timeout"
            : "cancelled",
        );
      if (error instanceof ResponseBodyError)
        throw new MiCloudError("invalid-response");
      if (error instanceof MiCloudError) throw error;
      throw new MiCloudError("network");
    }
  }

  #cookieHeader(url: URL) {
    return [
      "sdkVersion=accountsdk-18.8.15",
      `deviceId=${this.identity.clientId}`,
      this.#cookies.getCookieStringSync(url.toString()),
    ]
      .filter(Boolean)
      .join("; ");
  }

  #storeCookies(response: Response, url: URL) {
    for (const header of response.headers.getSetCookie()) {
      const cookie = Cookie.parse(header);
      if (!cookie) continue;
      // Anchor Max-Age to receipt; jar reads update lastAccessed.
      const expiryTime = cookie.expiryTime(new Date());
      if (
        cookie.maxAge !== null &&
        expiryTime !== undefined &&
        Number.isFinite(expiryTime)
      ) {
        cookie.expires = new Date(expiryTime);
        cookie.maxAge = null;
      }
      // Library errors can contain credentials and hostnames.
      const stored = this.#cookies.setCookieSync(cookie, url.toString(), {
        ignoreError: true,
      });
      this.#recordCookieWrite(stored);
    }
  }
}

function redirectOptions(
  options: RequestOptions,
  status: number,
  source: URL,
  destination: URL,
) {
  const headers = new Headers(options.headers);
  if (destination.origin !== source.origin) headers.delete("Authorization");
  const method = options.method?.toUpperCase() ?? "GET";
  if (
    ((status === 301 || status === 302) && method === "POST") ||
    (status === 303 && method !== "GET" && method !== "HEAD")
  ) {
    for (const name of [
      "Content-Encoding",
      "Content-Language",
      "Content-Location",
      "Content-Type",
      "Content-Length",
    ])
      headers.delete(name);
    const redirected = { ...options, headers, method: "GET" };
    delete redirected.body;
    return redirected;
  }
  return { ...options, headers };
}
