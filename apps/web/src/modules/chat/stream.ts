import {
  chatStreamEventSchema,
  chatInputSchema,
  apiErrorSchema,
} from "@home-agent/api/contracts";
import { rpc } from "../../api/client";
import { consumeEventStream } from "../../api/event-stream";
import { RequestError } from "../../api/errors";

export async function streamChat(
  input: ReturnType<typeof chatInputSchema.parse>,
  signal: AbortSignal,
  receive: (event: ReturnType<typeof chatStreamEventSchema.parse>) => void,
) {
  let started:
    | Extract<
        ReturnType<typeof chatStreamEventSchema.parse>,
        { event: "run_started" }
      >
    | undefined;
  let completed = false;
  await consumeEventStream(
    {
      signal,
      maxBufferSize: 256 * 1024,
      maxEventBytes: 256 * 1024,
      firstEventTimeoutMs: 15_000,
      silenceMs: 135_000,
      request: async (requestSignal) => {
        const response = await rpc.api.chat.$post(
          { json: input },
          { init: { signal: requestSignal } },
        );
        if (!response.ok) {
          const parsed = apiErrorSchema.safeParse(await response.json());
          throw new RequestError(
            parsed.success ? parsed.data : { code: "invalid_response" },
          );
        }
        return response;
      },
    },
    (message) => {
      const payload: unknown = JSON.parse(message.data);
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new RequestError({ code: "invalid_response" });
      const event = chatStreamEventSchema.parse({
        ...payload,
        event: message.event,
      });
      if (completed) throw new RequestError({ code: "invalid_response" });
      if (event.event === "run_started") {
        if (started || (input.threadId && input.threadId !== event.threadId))
          throw new RequestError({ code: "invalid_response" });
        started = event;
      } else {
        if (
          !started ||
          ("runId" in event &&
            (event.runId !== started.runId ||
              event.threadId !== started.threadId))
        )
          throw new RequestError({ code: "invalid_response" });
      }
      receive(event);
      if (event.event === "run_failed") throw new RequestError(event.error);
      if (event.event === "run_completed") completed = true;
    },
  );
  if (!completed) throw new RequestError({ code: "invalid_response" });
}
