import { z } from "zod";
import { deviceValueSchema } from "@home-agent/api/devices";
import { miotPropertyAddressSchema } from "./properties";

/** One write request is bounded independently of the cloud reading budget. */
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

const propertyResultSchema = miotPropertyAddressSchema.extend({
  code: z.number().int(),
});
const propertyResponseAddressSchema = miotPropertyAddressSchema.extend({
  code: z.unknown().optional(),
});
const actionResultSchema = miotActionRequestSchema
  .omit({ in: true })
  .extend({ code: z.number().int() });

function resultStatus(code: number) {
  // Write/action codes follow the SDK command contract, not cache-read heuristics.
  return code === 0
    ? { status: "accepted" as const, provider_code: code }
    : { status: "rejected" as const, provider_code: code };
}

export function propertyWriteResults(
  requested: readonly z.infer<typeof miotPropertyWriteSchema>[],
  response: unknown,
) {
  const rows = z.array(z.unknown()).safeParse(response);
  const parsed = rows.success
    ? rows.data.flatMap((value) => {
        const row = propertyResponseAddressSchema.safeParse(value);
        return row.success ? [row.data] : [];
      })
    : [];
  return requested.map(({ did, siid, piid }) => {
    const matches = parsed.filter(
      (row) => row.did === did && row.siid === siid && row.piid === piid,
    );
    const result =
      matches.length === 1 ? propertyResultSchema.safeParse(matches[0]) : null;
    const outcome = result?.success
      ? resultStatus(result.data.code)
      : { status: "unknown" as const, provider_code: null };
    return { did, siid, piid, ...outcome };
  });
}

export function actionResult(
  requested: z.infer<typeof miotActionRequestSchema>,
  response: unknown,
) {
  const parsed = actionResultSchema.safeParse(response);
  const { did, siid, aiid } = requested;
  const outcome =
    parsed.success &&
    parsed.data.did === did &&
    parsed.data.siid === siid &&
    parsed.data.aiid === aiid
      ? resultStatus(parsed.data.code)
      : { status: "unknown" as const, provider_code: null };
  return { did, siid, aiid, ...outcome };
}
