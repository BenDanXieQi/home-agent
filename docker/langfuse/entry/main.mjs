import { createServer } from "node:http";
import { createProxyServer } from "httpxy";

const upstream = "http://langfuse-web:3000";
const publicUrl = new URL(process.env.LANGFUSE_BASE_URL);
const email = process.env.LANGFUSE_INIT_USER_EMAIL;
const password = process.env.LANGFUSE_INIT_USER_PASSWORD;
const autoLogin = process.env.LANGFUSE_AUTO_LOGIN === "true";
if (autoLogin && (!email || !password)) {
  throw new Error(
    "Local Langfuse automatic login requires the configured account.",
  );
}
const proxy = createProxyServer({ target: upstream, proxyTimeout: 120_000 });

async function signIn() {
  const csrf = await fetch(`${upstream}/api/auth/csrf`, {
    headers: { host: publicUrl.host },
    signal: AbortSignal.timeout(10_000),
  });
  if (!csrf.ok) throw new Error("Langfuse login initialization failed.");
  const { csrfToken } = await csrf.json();
  if (typeof csrfToken !== "string") {
    throw new Error("Langfuse did not return a login token.");
  }
  const cookies = csrf.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0]);
  const login = await fetch(`${upstream}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      host: publicUrl.host,
      origin: publicUrl.origin,
      cookie: cookies.join("; "),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      csrfToken,
      email,
      password,
      callbackUrl: `${publicUrl.origin}/project/home-agent`,
      json: "true",
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const sessionCookies = login.headers.getSetCookie();
  if (
    !login.ok ||
    !sessionCookies.some((cookie) =>
      cookie.startsWith("next-auth.session-token"),
    )
  ) {
    throw new Error(
      "Automatic login failed. Check the configured account against the existing Langfuse user.",
    );
  }
  return sessionCookies;
}

async function handle(request, response) {
  if (
    ![publicUrl.host, `127.0.0.1:${publicUrl.port}`].includes(
      request.headers.host,
    )
  ) {
    response.writeHead(403);
    response.end("Local Langfuse entry only.");
    return;
  }
  const path = new URL(request.url, publicUrl).pathname;
  if (
    autoLogin &&
    request.method === "GET" &&
    (path === "/" || path === "/auth/sign-in")
  ) {
    const cookies = await signIn();
    response.writeHead(303, {
      "set-cookie": cookies,
      location: "/project/home-agent",
      "cache-control": "no-store",
    });
    response.end();
    return;
  }
  await proxy.web(request, response);
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Langfuse entry failed.",
    );
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      "Langfuse 自动登录或连接失败，请检查容器日志与 .env 中的本地账号。\n",
    );
  });
});
server.listen(3000, "0.0.0.0");
process.on("SIGTERM", () => {
  server.close();
});
