import { z } from "zod";
import { deviceValueSchema } from "@home-agent/api/devices";
import { miotPropertyAddressSchema } from "./properties";
import { providerPayload } from "../source-metadata";

export const MIOT_WRITE_BATCH_SIZE = 50;
export const MIOT_COMMAND_TIMEOUT_MS = 30_000;
export const miotPropertyWriteSchema = miotPropertyAddressSchema.extend({
  value: deviceValueSchema,
});
export const miotActionRequestSchema = miotPropertyAddressSchema
  .omit({ piid: true })
  .extend({
    aiid: z.number().int().positive(),
    in: z.array(deviceValueSchema),
  });
const codeSchema = z.number().int().safe();
const responseRowSchema = miotPropertyAddressSchema.extend({
  code: z.unknown().optional(),
  message: z.unknown().optional(),
});
const actionResponseSchema = miotActionRequestSchema.omit({ in: true }).extend({
  code: z.unknown().optional(),
  message: z.unknown().optional(),
  out: z.unknown().optional(),
});

// Only codes that establish rejection before execution belong here. Generic
// device/cloud errors, malformed results and timeouts cannot establish that.
// Source: MiEcosystem/miot-plugin-sdk wiki, 米家后台服务接口错误码对照表.
const rejectedCodes = new Set([
  -704010000, // unauthorized
  -704000000, // bad request
  -704000001, // bad request body
  -704090001, // device not found
  -704042001, // device not found
  -704042011, // device offline
  -704012901, // token absent or expired
  -704012902, // token invalid
  -704012903, // authorization expired
  -704012904, // device unauthorized
  -704012905, // device not bound
  -704012906, // OAuth failed
  -704040002, // service not found
  -704040003, // property not found
  -704030023, // property cannot write
  -704030992, // request denied by rate limit
  -704220043, // invalid property value
  -704040005, // action not found
  -704220035, // invalid action arguments
  -704220025, // action argument count mismatch
  -704040999, // operation not implemented
  -704013101, // operation not supported
]);

/** Provider acknowledgement never establishes a causal link to a later report. */
function resultStatus(code: number | null) {
  if (code === 0 || code === -702000000)
    return {
      status: "accepted" as const,
      outcome: "provider_succeeded" as const,
      provider_code: code,
    };
  if (code === 1 || code === -702010000 || code === -702022036)
    return {
      status: "accepted" as const,
      outcome: "pending" as const,
      provider_code: code,
    };
  if (code !== null && rejectedCodes.has(code))
    return {
      status: "rejected" as const,
      outcome: "rejected" as const,
      provider_code: code,
    };
  return {
    status: "unknown" as const,
    outcome: "unknown" as const,
    provider_code: code,
  };
}

export function propertyWriteResults(
  requested: readonly z.infer<typeof miotPropertyWriteSchema>[],
  response: unknown,
) {
  const rows = z.array(z.unknown()).safeParse(response);
  const parsed = rows.success
    ? rows.data.flatMap((raw) => {
        const row = responseRowSchema.safeParse(raw);
        return row.success ? [{ address: row.data, raw }] : [];
      })
    : [];
  return requested.map(({ did, siid, piid }) => {
    const matches = parsed.filter(
      ({ address }) =>
        address.did === did && address.siid === siid && address.piid === piid,
    );
    const matched = matches.length === 1 ? matches[0] : undefined;
    const code = codeSchema.safeParse(matched?.address.code);
    const savedResponse = providerPayload(matched ? matched.raw : response);
    return {
      did,
      siid,
      piid,
      ...resultStatus(code.success ? code.data : null),
      endpoint: "/miotspec/prop/set",
      response_matches: matches.length,
      message:
        typeof matched?.address.message === "string"
          ? matched.address.message
          : null,
      output: null,
      response: savedResponse.payload,
      completeness: savedResponse.omitted
        ? ("omitted" as const)
        : savedResponse.redacted
          ? ("partial" as const)
          : ("received_fields" as const),
    };
  });
}

export function actionResult(
  requested: z.infer<typeof miotActionRequestSchema>,
  response: unknown,
) {
  const parsed = actionResponseSchema.safeParse(response);
  const { did, siid, aiid } = requested;
  const matches =
    parsed.success &&
    parsed.data.did === did &&
    parsed.data.siid === siid &&
    parsed.data.aiid === aiid;
  const code = codeSchema.safeParse(matches ? parsed.data.code : null);
  const savedResponse = providerPayload(response);
  const savedOutput = providerPayload(
    matches ? (parsed.data.out ?? null) : null,
  );
  return {
    did,
    siid,
    aiid,
    ...resultStatus(code.success ? code.data : null),
    endpoint: "/miotspec/action",
    response_matches: matches ? 1 : 0,
    message:
      matches && typeof parsed.data.message === "string"
        ? parsed.data.message
        : null,
    output: savedOutput.omitted ? null : savedOutput.payload,
    response: savedResponse.payload,
    completeness:
      savedResponse.omitted || savedOutput.omitted
        ? ("omitted" as const)
        : savedResponse.redacted || savedOutput.redacted
          ? ("partial" as const)
          : ("received_fields" as const),
  };
}
