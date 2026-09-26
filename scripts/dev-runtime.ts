import { spawn } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { basename, resolve as resolvePath } from "node:path";
import { root, runtime } from "./go2rtc-runtime";

const applications = [
  { name: "Web", package: "web", host: "127.0.0.1", port: 5173 },
  // oxlint-disable-next-line turbo/no-undeclared-env-vars
  {
    name: "backend",
    package: "backend",
    host: process.env.BACKEND_HOST || "127.0.0.1",
    port: Number(process.env.BACKEND_PORT || 3000),
  },
  // oxlint-disable-next-line turbo/no-undeclared-env-vars
  {
    name: "Agent",
    package: "agent",
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

async function processOutput(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  if (await child.exited)
    throw new Error(`无法核对监听进程：${error.trim() || command[0]}`);
  return output.trim();
}

async function requireApplicationListener(app: (typeof applications)[number]) {
  const output = await processOutput([
    "lsof",
    "-nP",
    `-iTCP@${app.host}:${app.port}`,
    "-sTCP:LISTEN",
    "-Fp",
  ]);
  const pids = [
    ...new Set(
      output
        .split("\n")
        .filter((line) => /^p\d+$/.test(line))
        .map((line) => line.slice(1)),
    ),
  ];
  if (pids.length === 0)
    throw new Error(
      `${app.name} 端口 ${app.port} 已占用，但无法确认监听进程。`,
    );
  const directory = await realpath(resolvePath(root, "apps", app.package));
  const entry = await realpath(
    resolvePath(
      directory,
      app.package === "web" ? "node_modules/.bin/vite" : "src/main.ts",
    ),
  );
  for (const pid of pids) {
    const before = await identity(Number(pid));
    const cwd = (
      await processOutput(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"])
    )
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    const command = await processOutput(["ps", "-p", pid, "-o", "args="]);
    const [executable, ...args] = command.split(/\s+/);
    let matchesEntry = false;
    if (
      cwd === directory &&
      executable &&
      ["bun", "node"].includes(basename(executable))
    ) {
      for (const arg of args) {
        if (arg.startsWith("-")) continue;
        try {
          if ((await realpath(resolvePath(directory, arg))) === entry)
            matchesEntry = true;
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              (error.code === "ENOENT" || error.code === "ENOTDIR")
            )
          )
            throw error;
        }
      }
    }
    if (!matchesEntry || !before || (await identity(Number(pid))) !== before)
      throw new Error(
        `${app.name} 端口 ${app.port} 被其他进程占用或归属无法确认（PID ${pid}，目录 ${cwd ?? "未知"}）。请释放端口后重试。`,
      );
  }
  console.info(
    `${app.name} (${app.host}:${app.port}) 已在本项目运行（PID ${pids.join(", ")}），跳过启动。`,
  );
}

export async function pendingApplications() {
  const pending: (typeof applications)[number][] = [];
  for (const app of applications) {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(app.port, app.host, () => resolve());
      });
      pending.push(app);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "EADDRINUSE"
        )
      )
        throw error;
      await requireApplicationListener(app);
    } finally {
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  return pending;
}

const ownersDirectory = resolvePath(runtime, "dev-processes");
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

async function readOwner(ownerFile: string) {
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
    throw new Error("开发进程记录无效，请检查 config/runtime/dev-processes/。");
  return (await identity(owner.pid)) === owner.identity ? owner : undefined;
}

export async function devOwners() {
  await mkdir(ownersDirectory, { recursive: true, mode: 0o700 });
  const owners = [];
  for (const file of await readdir(ownersDirectory)) {
    if (!/^\d+\.json$/.test(file)) continue;
    const path = resolvePath(ownersDirectory, file);
    const owner = await readOwner(path);
    if (owner) owners.push(owner);
    else await rm(path, { force: true });
  }
  return owners;
}

export async function stopDev() {
  const owners = await devOwners();
  for (const owner of owners) process.kill(-owner.pid, "SIGTERM");
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await devOwners()).length === 0) return;
    await Bun.sleep(250);
  }
  throw new Error("开发进程未在 15 秒内退出；未停止其依赖，请检查后重试。");
}

export async function startDev(
  apps: Awaited<ReturnType<typeof pendingApplications>>,
) {
  if (apps.length === 0) return undefined;
  await mkdir(ownersDirectory, { recursive: true, mode: 0o700 });
  const child = spawn(
    launcher,
    ["run", "dev", ...apps.map((app) => `--filter=@home-agent/${app.package}`)],
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
    await writeFile(
      resolvePath(ownersDirectory, `${owner.pid}.json`),
      JSON.stringify(owner),
      { mode: 0o600 },
    );
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
      await rm(resolvePath(ownersDirectory, `${child.pid}.json`), {
        force: true,
      });
    }
  };
}
