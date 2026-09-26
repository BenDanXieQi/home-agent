import { z } from "zod";
import { Go2RtcAdapter } from "../../../src/mijia/media/go2rtc-adapter";

const requestBody = z
  .object({
    sessionId: z.string().optional(),
    sourceId: z.string().optional(),
    playbackId: z.string().optional(),
    did: z.string().optional(),
    offer: z.string().optional(),
    reset: z.boolean().optional(),
    channel: z.number().optional(),
    model: z.string().optional(),
  })
  .passthrough();

async function readCall(request: Request) {
  return {
    method: request.method,
    path: new URL(request.url).pathname.split("/").at(-1),
    application: request.headers.get("x-home-agent"),
    body: requestBody.parse(await request.json()),
  };
}

/** A local private-API peer, not a replacement for adapter/session domain behavior. */
export function mediaPeer(
  events?: ConstructorParameters<typeof Go2RtcAdapter>[1],
) {
  const calls: Awaited<ReturnType<typeof readCall>>[] = [];
  const handlers = new Map<
    string,
    (call: Awaited<ReturnType<typeof readCall>>) => Response | Promise<Response>
  >();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const call = await readCall(request);
      calls.push(call);
      const handler = handlers.get(`${call.method} ${call.path}`);
      if (handler) return handler(call);
      if (call.path === "heartbeat") return Response.json({ playbackIds: [] });
      if (call.path === "playback" && call.method === "POST")
        return Response.json({
          playbackId: call.body.playbackId,
          answer: "v=0\r\nfixture-answer",
        });
      return new Response(null, { status: 204 });
    },
  });
  const adapter = new Go2RtcAdapter(
    server.url.toString(),
    events ?? {
      onLost: () => {},
      activePlaybackIds: () => [],
      onPlaybackEnded: () => {},
    },
  );
  return {
    adapter,
    calls,
    handlers,
    async install() {
      await adapter.install({
        userId: "1001",
        passToken: "fixture-pass-token",
        region: "cn",
      });
      await adapter.renewSessionLease();
    },
    async close() {
      handlers.clear();
      try {
        await adapter.close();
      } finally {
        await server.stop(true);
      }
    },
  };
}

export const sourceId = "10000000-0000-4000-8000-000000000001";
export const camera = {
  did: "camera-1",
  model: "test.camera.single",
  isOnline: false,
};
