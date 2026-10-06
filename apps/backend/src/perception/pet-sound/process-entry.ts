import { inferenceRequest } from "../compute/inference-protocol";
import { sendProcessMessage } from "../compute/ipc";
import { createPetSoundModel } from "./model";
import { petSoundJobSchema, petSoundResponseSchema } from "./protocol";
import { petSoundModelSha256 } from "./model";
import type { z } from "zod";

function send(
  message: z.infer<typeof petSoundResponseSchema>,
  requestId: string | null = null,
) {
  return sendProcessMessage(message, requestId);
}
let failed = false;
function fatal(error: unknown) {
  if (failed) return;
  failed = true;
  send({ kind: "fatal", error: String(error).slice(0, 4096) })
    .catch((cause: unknown) => {
      console.error("Pet sound fatal publication failed", cause);
    })
    .finally(() => process.exit(1));
}
process.on("disconnect", () => {
  process.exit(0);
});
try {
  const model = await createPetSoundModel();
  process.on("message", (input: unknown) => {
    try {
      const { input: job, requestId } =
        inferenceRequest(petSoundJobSchema).parse(input);
      const started = performance.now();
      const events = model.classify(job.samples);
      send(
        {
          kind: "result",
          id: job.id,
          events,
          elapsedMs: performance.now() - started,
          rssBytes: process.memoryUsage().rss,
        },
        requestId,
      ).catch(fatal);
    } catch (error) {
      fatal(error);
    }
  });
  setInterval(() => {
    send({ kind: "pulse", rssBytes: process.memoryUsage().rss }).catch(fatal);
  }, 1000);
  await send({
    kind: "ready",
    modelSha256: petSoundModelSha256,
    rssBytes: process.memoryUsage().rss,
  });
} catch (error) {
  fatal(error);
}
