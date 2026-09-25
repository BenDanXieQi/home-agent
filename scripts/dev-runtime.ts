import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { resolve as resolvePath } from "node:path";
import { root, runtime } from "./go2rtc-runtime";

const applications = [
  { name: "Web", host: "127.0.0.1", port: 5173 },
  // oxlint-disable-next-line turbo/no-undeclared-env-vars
  {
    name: "backend",
    host: process.env.BACKEND_HOST || "127.0.0.1",
    port: Number(process.env.BACKEND_PORT || 3000),
  },
  // oxlint-disable-next-line turbo/no-undeclared-env-vars
  {
    name: "Agent",
    host: process.env.AGENT_HOST || "127.0.0.1",
    port: Number(process.env.AGENT_PORT || 1811),
  },
];

export async function applicationStatus() {
  for (const app of applications) {
    const listening = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: app.host, port: app.port });
      const finish = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1000, () => finish(false));
    });
    console.info(
      `${app.name} (${app.host}:${app.port})：${listening ? "端口可达" : "端口不可达"}`,
    );
  }
}

export async function requireFreeApplicationPorts() {
  for (const app of applications) {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(app.port, app.host, () => resolve());
      });
    } catch {
      throw new Error(
        `${app.name} 端口 ${app.port} 已占用或不可用。请先在原终端停止已有应用，再运行 dev；不会终止未知进程。`,
      );
    } finally {
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

const ownerFile = resolvePath(runtime, "dev.json");
const launcher = resolvePath(root, "node_modules/.bin/turbo");

async function identity(pid: number) {
  const child = Bun.spawn(
    ["ps", "-p", String(pid), "-o", "lstart=", "-o", "args="],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = (await new Response(child.stdout).text()).trim();
  const error = await new Response(child.stderr).text();
  if (await child.exited) {
    if (error.trim()) throw new Error(`无法检查开发进程：${error.trim()}`);
    return "";
  }
  return output;
}

export async function devOwner() {
  let owner: { pid: number; identity: string };
  try {
    owner = JSON.parse(await readFile(ownerFile, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !owner.identity?.includes(launcher)
  )
    throw new Error("开发进程记录无效，请检查 config/runtime/dev.json。");
  return (await identity(owner.pid)) === owner.identity ? owner : undefined;
}

export async function stopDev() {
  const owner = await devOwner();
  if (!owner) return;
  process.kill(-owner.pid, "SIGTERM");
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await identity(owner.pid)) !== owner.identity) return;
    await Bun.sleep(250);
  }
  throw new Error("开发进程未在 15 秒内退出；未停止其依赖，请检查后重试。");
}

export async function startDev() {
  const child = spawn(
    launcher,
    [
      "run",
      "dev",
      "--filter=@home-agent/web",
      "--filter=@home-agent/backend",
      "--filter=@home-agent/agent",
    ],
    {
      cwd: root,
      stdio: "inherit",
      detached: true,
    },
  );
  const done = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve(code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1)),
    );
  });
  const terminate = () => {
    if (child.exitCode === null && child.signalCode === null && child.pid)
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        )
          throw error;
      }
  };
  process.on("SIGINT", terminate);
  process.on("SIGTERM", terminate);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const owner = { pid: child.pid!, identity: await identity(child.pid!) };
    if (!owner.identity.includes(launcher))
      throw new Error("开发进程启动失败。");
    await writeFile(ownerFile, JSON.stringify(owner), { mode: 0o600 });
  } catch (error) {
    terminate();
    await done.catch(() => {});
    process.off("SIGINT", terminate);
    process.off("SIGTERM", terminate);
    throw error;
  }
  return async () => {
    try {
      return await done;
    } finally {
      terminate();
      process.off("SIGINT", terminate);
      process.off("SIGTERM", terminate);
      // Keep the identity record; a later launch replaces it after validation.
    }
  };
}
