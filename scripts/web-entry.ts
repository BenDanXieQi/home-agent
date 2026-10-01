import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const directory = resolve(root, "config/runtime/caddy");
const socket = resolve(directory, "admin.sock");
const address = `unix/${socket}`;
const config = resolve(root, "deploy/web/Caddyfile");

async function runCaddy(args: string[], mode = "development") {
  const binary = Bun.which("caddy");
  if (!binary)
    throw new Error(
      "请先安装 Caddy：macOS 使用 brew install caddy；其他平台见 docs/running.md。",
    );
  const child = spawn(binary, args, {
    cwd: root,
    env: {
      ...process.env,
      HOME_AGENT_ROOT: root,
      HOME_AGENT_WEB_MODE: mode,
      HOME_AGENT_CADDY_SOCKET: socket,
      HOME_AGENT_CADDY_DATA: resolve(directory, "data"),
      HOME_AGENT_CADDY_LOG: resolve(directory, "caddy.log"),
    },
    stdio: "inherit",
    detached: args[0] === "start",
  });
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  if (code !== 0)
    throw new Error("Caddy 操作失败，请检查 config/runtime/caddy/caddy.log。");
}

export async function webEntryRunning() {
  if (!existsSync(socket)) return false;
  return await new Promise<boolean>((done, reject) => {
    const req = request(
      {
        socketPath: socket,
        path: "/config/",
        signal: AbortSignal.timeout(2000),
      },
      (response) => {
        response.resume();
        if (response.statusCode === 200) done(true);
        else reject(new Error(`Caddy 状态查询失败：${response.statusCode}`));
      },
    );
    req.once("error", (error) => {
      if (
        "code" in error &&
        ["ENOENT", "ECONNREFUSED"].includes(String(error.code))
      )
        done(false);
      else reject(error);
    });
    req.end();
  });
}

export async function startWebEntry(mode: "development" | "production") {
  if (
    mode === "production" &&
    !existsSync(resolve(root, "apps/backend/dist/public/index.html"))
  )
    throw new Error("缺少生产页面，请先运行 bun run build。");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await runCaddy(["validate", "--config", config], mode);
  await runCaddy(
    (await webEntryRunning())
      ? ["reload", "--config", config, "--address", address]
      : ["start", "--config", config],
    mode,
  );
  console.info(`Web 入口：https://localhost:8443（${mode}）`);
  console.info("首次使用需运行 bun run web:trust，完成系统证书信任。");
}

export async function stopWebEntry() {
  if (await webEntryRunning()) await runCaddy(["stop", "--address", address]);
}

if (import.meta.main) {
  const [action, ...args] = process.argv.slice(2);
  if (args.length > 0) throw new Error("Web 入口命令不接受额外参数。");
  switch (action) {
    case "development":
    case "production":
      await startWebEntry(action);
      break;
    case "trust":
      await runCaddy(["trust", "--address", address]);
      break;
    case "stop":
      await stopWebEntry();
      break;
    default:
      throw new Error(
        "用法：bun scripts/web-entry.ts development|production|trust|stop",
      );
  }
}
