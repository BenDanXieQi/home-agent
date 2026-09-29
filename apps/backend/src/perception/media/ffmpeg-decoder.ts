import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pTimeout from "p-timeout";
import { createFrameAssembler } from "./frame-assembler";

export function createFfmpegDecoder(options: {
  executable: string;
  read: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
  sampleFps: number;
  firstFrameTimeoutMs: number;
  silenceTimeoutMs: number;
  onFrame: Parameters<typeof createFrameAssembler>[0];
}) {
  const controller = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let diagnostic = "";
  let exit: Promise<unknown> = Promise.resolve();
  function arm(milliseconds: number) {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        controller.abort(new Error("Video complete-frame deadline exceeded")),
      milliseconds,
    );
  }
  const assembler = createFrameAssembler((frame) => {
    arm(options.silenceTimeoutMs);
    options.onFrame(frame);
  });
  const completed = (async () => {
    arm(options.firstFrameTimeoutMs);
    try {
      const stream = await options.read(controller.signal);
      controller.signal.throwIfAborted();
      // No new process group: the compute supervisor owns this entire process tree.
      child = spawn(
        options.executable,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-threads",
          "1",
          "-max_alloc",
          "33554432",
          "-max_pixels",
          "8294400",
          "-probesize",
          "1048576",
          "-analyzeduration",
          "1000000",
          "-f",
          "mpegts",
          "-i",
          "pipe:0",
          "-map",
          "0:v:0",
          "-an",
          "-sn",
          "-dn",
          "-threads",
          "1",
          "-filter_threads",
          "1",
          // Select actual input frames before RGB conversion; never manufacture repeats.
          "-vf",
          `select='isnan(prev_selected_t)+lt(t,prev_selected_t)+gte(t-prev_selected_t,${1 / options.sampleFps})'`,
          "-fps_mode",
          "passthrough",
          "-c:v",
          "ppm",
          "-pix_fmt",
          "rgb24",
          "-f",
          "image2pipe",
          "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      exit = new Promise<void>((resolve, reject) => {
        child!.once("error", (error) => {
          diagnostic = error.message;
          if (child?.pid === undefined) resolve();
          else reject(error);
        });
        child!.once("exit", () => resolve());
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-2048);
      });
      const input = pipeline(Readable.fromWeb(stream), child.stdin!, {
        signal: controller.signal,
      });
      const output = (async () => {
        for await (const chunk of child.stdout!) {
          controller.signal.throwIfAborted();
          assembler.push(chunk);
        }
        throw new Error(`Video decoder ended: ${diagnostic}`);
      })();
      await Promise.race([
        input.then(() => {
          throw new Error("Analysis stream ended");
        }),
        output,
        exit.then(() => {
          throw new Error(`FFmpeg exited: ${diagnostic}`);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      controller.abort();
      assembler.clear();
      child?.kill("SIGKILL");
      await pTimeout(exit, {
        milliseconds: 3000,
        message: "FFmpeg exit unconfirmed",
      });
    }
  })();
  return {
    completed,
    close() {
      closing ??= (async () => {
        controller.abort(new Error("Video source stopped"));
        child?.kill("SIGKILL");
        await Promise.allSettled([completed]);
        await pTimeout(exit, {
          milliseconds: 3000,
          message: "FFmpeg exit unconfirmed",
        });
      })();
      return closing;
    },
  };
}
