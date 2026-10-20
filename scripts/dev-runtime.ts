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
  {
    name: "Web",
    package: "web",
    host: "127.0.0.1",
    port: 5173,
    healthPath: "/",
  },
  // oxlint-disable-next-line turbo/no-undeclared-env-vars
  {
    name: "backend",
    package: "backend",
    host: process.env.BACKEND_HOST || "127.0.0.1",
    port: Number(process.env.BACKEND_PORT || 3000),
    healthPath: "/api/health",
  },
  // oxlint-disable-next-line turbo/no-undeclared-env-vars
  {
    name: "Agent",
    package: "agent-host",
    host: process.env.AGENT_HOST || "127.0.0.1",
    port: Number(process.env.AGENT_PORT || 1811),
    healthPath: "/health",
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
      app.package === "web"
        ? "node_modules/.bin/vite"
        : app.package === "agent-host"
          ? "scripts/dev.ts"
          : "src/main.ts",
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

async function waitForApplications(
  apps: (typeof applications)[number][],
  signal: AbortSignal,
) {
  const pending = new Map(apps.map((app) => [app, "尚未响应"]));
  const deadline = performance.now() + 120_000;
  while (pending.size > 0) {
    signal.throwIfAborted();
    await Promise.all(
      Array.from(pending.keys(), async (app) => {
        const url = new URL(app.healthPath, `http://${app.host}:${app.port}`);
        try {
          const response = await fetch(url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
            redirect: "error",
          });
          await response.body?.cancel();
          if (!response.ok) {
            pending.set(app, `HTTP ${response.status}`);
            return;
          }
          pending.delete(app);
          console.info(`${app.name} (${url.toString()}) 已就绪。`);
        } catch (error) {
          signal.throwIfAborted();
          pending.set(
            app,
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    );
    signal.throwIfAborted();
    if (pending.size === 0) return;
    if (performance.now() >= deadline)
      throw new Error(
        `开发应用启动失败，120 秒内未就绪：${Array.from(pending, ([app, reason]) => `${app.name} (${app.host}:${app.port})：${reason}`).join("；")}。请检查上方对应服务的错误日志。`,
      );
    await Bun.sleep(500);
  }
}

const ownersDirectory = resolvePath(runtime, "dev-processes");
const launcher = resolvePath(root, "node_modules/.bin/turbo");

async function identity(pid: number) {
  const child = Bun.spawn(
    ["ps", "-ww", "-p", String(pid), "-o", "lstart=", "-o", "args="],
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
    [
      "run",
      "dev",
      "--ui=stream",
      "--log-order=stream",
      ...apps.map((app) => `--filter=@home-agent/${app.package}`),
    ],
    {
      cwd: root,
      stdio: "inherit",
      detached: true,
    },
  );
  const stopped = new AbortController();
  const done = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      stopped.abort(
        new Error(
          `开发进程已退出（${signal ?? `退出码 ${code}`}），请检查上方错误日志。`,
        ),
      );
      resolve(code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1));
    });
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
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    terminate();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const owner = { pid: child.pid!, identity: "" };
    const deadline = performance.now() + 2000;
    for (;;) {
      owner.identity = await identity(owner.pid);
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `开发进程启动后已退出（PID ${owner.pid}，${child.signalCode ?? `退出码 ${child.exitCode}`}）。`,
        );
      if (owner.identity.includes(launcher)) break;
      if (performance.now() >= deadline)
        throw new Error(
          `开发进程身份确认超时（PID ${owner.pid}）：${owner.identity || "未取得进程信息"}`,
        );
      await Bun.sleep(25);
    }
    await writeFile(
      resolvePath(ownersDirectory, `${owner.pid}.json`),
      JSON.stringify(owner),
      { mode: 0o600 },
    );
    await waitForApplications(apps, stopped.signal);
  } catch (error) {
    terminate();
    await Promise.allSettled([done]);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await rm(resolvePath(ownersDirectory, `${child.pid}.json`), {
      force: true,
    });
    if (interrupted) return undefined;
    throw error;
  }
  return async () => {
    try {
      return await done;
    } finally {
      terminate();
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      await rm(resolvePath(ownersDirectory, `${child.pid}.json`), {
        force: true,
      });
    }
  };
}
