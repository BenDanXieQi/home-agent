import { createSpeechModel } from "./model";
import { speechJobSchema, speechResponseSchema } from "./protocol";
import { senseVoiceModel } from "./limits";
import type { z } from "zod";

function send(message: z.infer<typeof speechResponseSchema>) {
  return new Promise<void>((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("Speech IPC unavailable"));
      return;
    }
    process.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
let failed = false;
function fatal(error: unknown) {
  if (failed) return;
  failed = true;
  send({ kind: "fatal", error: String(error).slice(0, 4096) })
    .finally(() => process.exit(1))
    .catch((cause: unknown) => {
      console.error("Speech fatal publication failed", cause);
    });
}
process.on("disconnect", () => {
  process.exit(0);
});
try {
  const model = await createSpeechModel();
  process.on("message", (input: unknown) => {
    try {
      const job = speechJobSchema.parse(input);
      const result = model.recognize(job.samples);
      send({
        kind: "result",
        id: job.id,
        ...result,
        rssBytes: process.memoryUsage().rss,
      }).catch(fatal);
    } catch (error) {
      fatal(error);
    }
  });
  setInterval(() => {
    send({ kind: "pulse", rssBytes: process.memoryUsage().rss }).catch(fatal);
  }, 1000);
  await send({
    kind: "ready",
    modelSha256: senseVoiceModel.sha256,
    rssBytes: process.memoryUsage().rss,
  });
} catch (error) {
  fatal(error);
}
