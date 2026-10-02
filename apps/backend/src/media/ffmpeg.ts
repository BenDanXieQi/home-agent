import { execFile } from "node:child_process";
import pTimeout from "p-timeout";
import { MediaCleanupError } from "./resources";

export async function runFfmpeg(
  executable: string,
  args: string[],
  signal: AbortSignal,
  maxBuffer: number,
) {
  signal.throwIfAborted();
  const completion = Promise.withResolvers<string>();
  const child = execFile(
    executable,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-threads",
      "1",
      ...args,
    ],
    {
      signal,
      killSignal: "SIGKILL",
      maxBuffer,
      encoding: "utf8",
      windowsHide: true,
    },
    (cause, stdout) => {
      if (cause)
        completion.reject(new Error("Media process failed", { cause }));
      else completion.resolve(stdout);
    },
  );
  const closed = new Promise<void>((resolve) => {
    child.once("close", resolve);
  });
  try {
    const output = await completion.promise;
    signal.throwIfAborted();
    return output;
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await pTimeout(closed, {
      milliseconds: 3000,
      message: new MediaCleanupError("Media process exit unconfirmed"),
    });
  }
}
