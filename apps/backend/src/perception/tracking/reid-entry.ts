import { inferenceRequest } from "../compute/inference-protocol";
import { createReid } from "./reid";
import { reidRequestSchema, reidResponseSchema } from "./reid-protocol";
import { sendProcessMessage } from "../compute/ipc";
import type { z } from "zod";
function send(
  value: z.infer<typeof reidResponseSchema>,
  requestId: string | null = null,
) {
  return sendProcessMessage(value, requestId);
}
let failed = false;
function fatal(error: unknown) {
  if (failed) return;
  failed = true;
  send({ kind: "failed", error: String(error).slice(0, 4096) })
    .catch((cause: unknown) => {
      console.error("ReID failure delivery failed", cause);
    })
    .finally(() => process.exit(1));
}
process.on("disconnect", () => {
  process.exit(0);
});
try {
  const model = await createReid();
  let busy = false;
  async function receive(message: unknown) {
    if (busy) throw new Error("ReID capacity exceeded");
    busy = true;
    try {
      const { input, requestId } =
        inferenceRequest(reidRequestSchema).parse(message);
      const features = await model.extract(input);
      await send({ kind: "features", features }, requestId);
    } finally {
      busy = false;
    }
  }
  process.on("message", (message: unknown) => {
    receive(message).catch(fatal);
  });
  await send({ kind: "ready" });
} catch (error) {
  fatal(error);
}
