import { parseProviderJson } from "../json";
import { createHash } from "node:crypto";
import { z } from "zod";
import { MiCloudTransport, trustedUrl } from "./transport";
import { MiCloudError } from "./errors";
import type { MiCloudSavedSession } from "./session";

const object = z.looseObject({});
export const speakerSchema = z.object({
  deviceID: z.string().min(1),
  miotDID: z.string().min(1),
  hardware: z.string().min(1),
});
export const conversationPageSchema = z.object({
  records: z.array(
    z.looseObject({
      requestId: z.string().min(1),
      time: z.number().int().safe().nonnegative(),
      query: z.string(),
      answers: z.array(z.unknown()),
      illegalContent: z.unknown(),
      bitSet: z.unknown(),
    }),
  ),
  nextEndTime: z.number().int().safe().nonnegative().optional(),
});
/** Mico tokens are isolated from the MiCloud session and discarded with it. */
export class MicoClient {
  private token: string | undefined;
  private authentication: Promise<void> | undefined;
  private readonly controller = new AbortController();
  constructor(private readonly saved: MiCloudSavedSession) {}
  private transport(clientId = this.saved.clientId) {
    return new MiCloudTransport(
      { clientId, userAgent: this.saved.userAgent },
      () => {},
    );
  }
  private async authenticate(signal: AbortSignal) {
    const transport = this.transport();
    try {
      const url = new URL(
        "https://account.xiaomi.com/pass/serviceLogin?sid=micoapi&_json=true",
      );
      for (const key of ["userId", "passToken"] as const)
        transport.setCookie(key, this.saved[key], url.href, { path: "/pass" });
      const login = object.parse(
        parseProviderJson(
          (
            await transport.request(url, { rejectRedirects: true }, signal)
          ).body.toString("utf8"),
        ),
      );
      if (login.code !== 0 || login.notificationUrl)
        throw new MiCloudError("authentication");
      const credentials = z
        .object({
          location: z.string(),
          nonce: z.union([z.string(), z.number().safe()]),
          ssecurity: z.string(),
        })
        .parse(login);
      const destination = trustedUrl(credentials.location);
      if (destination.hostname !== "api2.mina.mi.com")
        throw new MiCloudError("invalid-response");
      destination.searchParams.set(
        "clientSign",
        createHash("sha1")
          .update(`nonce=${credentials.nonce}&${credentials.ssecurity}`)
          .digest("base64"),
      );
      await transport.request(
        destination,
        { sameOriginRedirects: true },
        signal,
      );
      this.token = transport.cookie("serviceToken", destination)?.value;
      if (!this.token) throw new MiCloudError("missing-credentials");
    } finally {
      transport.dispose();
    }
  }
  private async request(url: URL, signal: AbortSignal, speakerId?: string) {
    const combined = AbortSignal.any([
      signal,
      this.controller.signal,
      AbortSignal.timeout(30_000),
    ]);
    if (!this.token) {
      this.authentication ??= this.authenticate(combined).finally(() => {
        this.authentication = undefined;
      });
      await this.authentication;
    }
    const transport = this.transport(speakerId);
    try {
      transport.setCookie("userId", this.saved.userId, url.href, { path: "/" });
      transport.setCookie("serviceToken", this.token!, url.href, { path: "/" });
      const response = await transport.request(
        url,
        { rejectRedirects: true },
        combined,
      );
      const envelope = object.parse(
        parseProviderJson(response.body.toString("utf8")),
      );
      if (
        envelope.code === 401 ||
        envelope.code === -3 ||
        envelope.code === 3
      ) {
        this.token = undefined;
        throw new MiCloudError("authentication");
      }
      if (envelope.code !== 0)
        throw new MiCloudError(
          "invalid-response",
          typeof envelope.code === "number"
            ? { upstreamCode: envelope.code }
            : {},
        );
      return typeof envelope.data === "string"
        ? parseProviderJson(envelope.data)
        : envelope.data;
    } catch (error) {
      if (
        error instanceof MiCloudError &&
        (error.httpStatus === 401 || error.code === "authentication")
      )
        this.token = undefined;
      throw error;
    } finally {
      transport.dispose();
    }
  }
  async devices(signal: AbortSignal) {
    return speakerSchema
      .array()
      .parse(
        await this.request(
          new URL("https://api2.mina.mi.com/admin/v2/device_list"),
          signal,
        ),
      );
  }
  async conversations(
    speaker: z.infer<typeof speakerSchema>,
    timestamp: number,
    limit: number,
    signal: AbortSignal,
  ) {
    const url = new URL(
      "https://userprofile.mina.mi.com/device_profile/v2/conversation",
    );
    url.search = new URLSearchParams({
      hardware: speaker.hardware,
      timestamp: String(timestamp),
      limit: String(limit),
    }).toString();
    return conversationPageSchema.parse(
      await this.request(url, signal, speaker.deviceID),
    );
  }
  dispose() {
    this.controller.abort();
    this.token = undefined;
  }
}
