import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

export const root = resolve(import.meta.dir, "..");
export const runtime = resolve(root, "config/runtime");
const binary = resolve(runtime, "bin/go2rtc");
const ownerFile = resolve(runtime, "go2rtc.json");
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function identity(pid: number) {
  const result = Bun.spawn(
    ["ps", "-p", String(pid), "-o", "lstart=", "-o", "args="],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const output = (await new Response(result.stdout).text()).trim();
  return (await result.exited) === 0 ? output : "";
}

async function nativeOwner() {
  let saved: { pid: number; identity: string };
  try {
    saved = JSON.parse(await readFile(ownerFile, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  if (
    !Number.isSafeInteger(saved.pid) ||
    saved.pid <= 0 ||
    !saved.identity?.includes(binary)
  )
    throw new Error(
      "原生 go2rtc 运行记录无效，请检查 config/runtime/go2rtc.json。",
    );
  if ((await identity(saved.pid)) !== saved.identity) {
    await unlink(ownerFile);
    return undefined;
  }
  return saved;
}

export async function nativeRunning() {
  return Boolean(await nativeOwner());
}

export async function stopNative() {
  const owner = await nativeOwner();
  if (!owner) return;
  process.kill(owner.pid, "SIGTERM");
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await identity(owner.pid)) !== owner.identity) {
      await unlink(ownerFile);
      return;
    }
    await delay(250);
  }
  throw new Error("原生 go2rtc 未在 15 秒内退出；未强制终止，请检查后重试。");
}

/** Probe every published media port; never adopt or terminate an unknown owner. */
export async function requireFreePorts() {
  const servers: ReturnType<typeof createServer>[] = [];
  const udp = createSocket("udp4");
  try {
    for (const port of [1984, 8554, 8555]) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => done());
      });
    }
    await new Promise<void>((done, reject) => {
      udp.once("error", reject);
      udp.bind(8555, "127.0.0.1", () => done());
    });
  } catch {
    throw new Error(
      "go2rtc 端口 1984/8554/8555 已被其他进程占用。请先停止该实例；不会自动换端口或终止未知进程。",
    );
  } finally {
    for (const server of servers)
      if (server.listening)
        await new Promise<void>((done) => server.close(() => done()));
    try {
      udp.close();
    } catch {
      /* The UDP socket may not have bound. */
    }
  }
}

export async function startNative(
  runDocker: (args: string[]) => Promise<void>,
) {
  if (
    !["darwin", "linux"].includes(process.platform) ||
    !["arm64", "x64"].includes(process.arch)
  )
    throw new Error("原生模式支持 macOS/Linux 的 arm64 和 x64。");
  await mkdir(resolve(runtime, "bin"), { recursive: true, mode: 0o700 });
  await runDocker([
    "build",
    "--target",
    "native",
    "--build-arg",
    `NATIVE_OS=${process.platform}`,
    "--build-arg",
    `NATIVE_ARCH=${process.arch === "x64" ? "amd64" : "arm64"}`,
    "--output",
    `type=local,dest=${resolve(runtime, "bin")}`,
    resolve(root, "docker/go2rtc"),
  ]);
  await requireFreePorts();
  const log = openSync(resolve(runtime, "go2rtc.log"), "a", 0o600);
  const child = spawn(
    binary,
    [
      "-config",
      resolve(root, "config/go2rtc/go2rtc.yaml"),
      "-config",
      JSON.stringify({
        api: { listen: "127.0.0.1:1984" },
        rtsp: { listen: "127.0.0.1:8554" },
        webrtc: {
          listen: "127.0.0.1:8555",
          candidates: ["127.0.0.1:8555"],
          filters: { loopback: true },
        },
      }),
    ],
    { cwd: root, detached: true, stdio: ["ignore", log, log] },
  );
  closeSync(log);
  await new Promise<void>((done, reject) => {
    child.once("spawn", done);
    child.once("error", reject);
  });
  child.unref();
  try {
    const owner = { pid: child.pid!, identity: await identity(child.pid!) };
    if (!owner.identity.includes(binary))
      throw new Error(
        "原生 go2rtc 启动失败，请查看 config/runtime/go2rtc.log。",
      );
    await writeFile(ownerFile, JSON.stringify(owner), { mode: 0o600 });
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await identity(owner.pid)) !== owner.identity) break;
      try {
        const response = await fetch("http://127.0.0.1:1984/api", {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {
        /* Wait for the owned process to start listening. */
      }
      await delay(250);
    }
    throw new Error("原生 go2rtc 未就绪，请查看 config/runtime/go2rtc.log。");
  } catch (error) {
    // The ChildProcess handle belongs to this launch, never to an adopted PID.
    if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }
}
