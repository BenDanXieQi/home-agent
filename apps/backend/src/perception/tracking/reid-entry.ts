import { createReid } from "./reid";
import { reidRequestSchema, reidResponseSchema } from "./reid-protocol";
import type { z } from "zod";
function send(value: z.infer<typeof reidResponseSchema>) {
  process.send?.(value);
}
try {
  const model = await createReid();
  let busy = false;
  process.on("message", (message: unknown) => {
    if (busy) {
      send({ kind: "failed", error: "ReID capacity exceeded" });
      return;
    }
    busy = true;
    Promise.resolve()
      .then(() => model.extract(reidRequestSchema.parse(message)))
      .then(
        (features) => send({ kind: "features", features }),
        (error: unknown) =>
          send({ kind: "failed", error: String(error).slice(0, 4096) }),
      )
      .finally(() => {
        busy = false;
      });
  });
  process.on("disconnect", () => {
    process.exit(0);
  });
  send({ kind: "ready" });
} catch (error) {
  send({ kind: "failed", error: String(error).slice(0, 4096) });
  process.exitCode = 1;
}
