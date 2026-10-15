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

const rejectedCodes = new Set([
  -704010000, -704000000, -704000001, -704090001, -704042001, -704042011,
  -704012901, -704012902, -704012903, -704012904, -704012905, -704012906,
  -704040002, -704040003, -704030023, -704030992, -704220043, -704040005,
  -704220035, -704220025, -704040999, -704013101,
]);

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
