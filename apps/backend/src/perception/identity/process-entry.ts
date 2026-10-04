import { createIdentityModel } from "./model";
import {
  identityRequestSchema,
  identityResponseSchema,
  identityPrepareSchema,
} from "./protocol";
import type { z } from "zod";

function send(value: z.infer<typeof identityResponseSchema>) {
  return new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error("Identity IPC disconnected"));
      return;
    }
    process.send(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
try {
  const directory = process.argv[2];
  if (!directory) throw new Error("Identity model directory is required");
  const model = createIdentityModel(directory);
  let busy = false;
  async function receive(message: unknown) {
    if (busy) throw new Error("Identity capacity exceeded");
    busy = true;
    try {
      await send(
        identityResponseSchema.parse(
          await (async () => {
            const preparation = identityPrepareSchema.safeParse(message);
            return preparation.success
              ? model.prepare(preparation.data.classes)
              : model.extract(identityRequestSchema.parse(message));
          })(),
        ),
      );
    } finally {
      busy = false;
    }
  }
  process.on("message", (message: unknown) => {
    receive(message).catch(async (error: unknown) => {
      try {
        await send({ kind: "failed", error: String(error).slice(0, 4096) });
      } catch (cause) {
        console.error("Identity failure delivery failed", cause);
      }
      process.exit(1);
    });
  });
  process.on("disconnect", () => {
    process.exit(0);
  });
  await send({ kind: "ready", version: model.metadata.version });
} catch (error) {
  try {
    await send({ kind: "failed", error: String(error).slice(0, 4096) });
  } catch (cause) {
    console.error("Identity initialization delivery failed", cause);
  }
  process.exit(1);
}
