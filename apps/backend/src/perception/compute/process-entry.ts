import { createInferencePool } from "./inference-pool";
import {
  errorDetails,
  requestSchema,
  responseSchema,
  taskSchema,
} from "./protocol";
import type { z } from "zod";

let pool: ReturnType<typeof createInferencePool> | undefined;
let initialized = false;
let closing = false;
let failed = false;
function fail(error: unknown) {
  if (failed) return;
  failed = true;
  process.exitCode = 1;
  const details = errorDetails(error);
  console.error(details.stack ?? details.message);
  // Flush the fatal IPC message before leaving this isolated process.
  send({ kind: "fatal", ...details })
    .finally(() => process.exit(1))
    .catch(() => {});
}
async function run(task: z.infer<typeof taskSchema>) {
  if (task.kind === "initialize") {
    if (pool) throw new Error("Inference pool is already created");
    pool = createInferencePool(fail);
    const result = await pool.submit(task);
    initialized = true;
    return result;
  }
  if (!pool || !initialized) throw new Error("Inference pool is not ready");
  if (closing) throw new Error("Inference pool is closing");
  if (task.kind === "close") {
    closing = true;
    return await pool.close();
  }
  return await pool.submit(task);
}
function send(message: z.infer<typeof responseSchema>) {
  return new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error("Detection process IPC disconnected"));
      return;
    }
    process.send(message, (error: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
// Piscina, rather than an IPC promise chain, owns the compute queue.
process.on("message", (message: unknown) => {
  const receivedAt = performance.now();
  const request = requestSchema.safeParse(message);
  if (!request.success) {
    fail(request.error);
    return;
  }
  run(request.data.task)
    .then(
      (result) =>
        send({
          kind: "result",
          id: request.data.id,
          result,
          processingMs: performance.now() - receivedAt,
        }),
      (error: unknown) =>
        send({
          kind: "error",
          id: request.data.id,
          ...errorDetails(error),
        }),
    )
    .catch(fail);
});
// No thread termination here; losing the parent ends this isolated process.
process.on("disconnect", () => process.exit(failed ? 1 : 0));
send({ kind: "ready" }).catch(fail);
