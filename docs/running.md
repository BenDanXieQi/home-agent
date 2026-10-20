# 本地运行

```sh
bun run dev                    # 沿用已选模式，首次默认 docker
bun run dev --mode native      # 使用本机 go2rtc
bun run dev --mode docker      # 使用 Docker go2rtc
bun run stop                   # 停止应用和依赖，保留数据
bun run status                 # 查看运行状态
```

`bun run dev` 启动或重载本项目的 Caddy HTTPS 入口，并逐项补齐未启动的服务：Web、backend、Agent 的端口已占用时，通过 `lsof` 和 `ps` 核对监听进程的工作目录、运行入口和进程身份，只跳过本项目对应的应用；其他项目占用端口或无法确认归属时明确报错；所选模式的 go2rtc 已运行时跳过启动；数据库通过 Compose 启动并等待健康检查通过，随后初始化当前数据库结构并检查，成功后才启动 HTTPS 入口和应用。数据库结构由 Drizzle 当前迁移集合建立，已登记应用的 SQL 不重复执行。进程归属检查不代表应用健康；本机须提供 `lsof` 和 `ps`。全部已启动时命令正常退出。按 Ctrl+C 只停止当前命令新启动的应用，`bun run stop` 停止本项目的 HTTPS 入口、记录的所有开发进程及依赖，不终止单独手动启动的应用。

新启动的应用使用带服务名前缀的连续日志输出，Agent 重载保留已有日志。启动命令等待 Web `/`、backend `/api/health` 和 Agent `/health` 返回成功响应，逐项显示就绪；120 秒内仍未就绪时，列出失败应用及最近的探测错误，以非零退出码结束，并停止本次新启动的应用、移除对应进程记录，保留已有应用与依赖。此检查只确认启动时的 HTTP 接口可用，不代表模型、米家或摄像头就绪。运行中修改代码导致错误时，监听进程可能继续等待修正，须查看对应服务的错误日志；命令仍在运行不表示服务仍然健康。

两种模式都需要 Docker，分别用于数据库和 go2rtc 构建／运行，无需本机安装 Go。首次构建需联网。模式切换由启动命令管理，会中断现有播放；不要同时手工启动另一套 go2rtc。

修改 `docker/go2rtc/` 源码后，需要重新构建并重启 go2rtc；已运行的服务不会因再次执行 `bun run dev` 自动更新。Docker 模式使用 `docker compose up -d --build --no-deps go2rtc`，原生模式使用 `bun run stop` 后再执行 `bun run dev --mode native`。重启期间摄像头连接会中断并重新建立。音频请求返回 HTTP 404、`invalid_request` 时，应核对运行产物是否包含当前音频接口。

go2rtc 配置位于 `config/go2rtc/go2rtc.yaml`，运行产物和日志位于 `config/runtime/`，均不提交 Git。修改配置后用 `bun run stop`、`bun run dev` 重启。开发终端按 Ctrl+C 后依赖进程仍保持运行，但 backend 正常关闭会请求释放其 go2rtc 运行时会话和媒体资源；go2rtc 进程仍在不等于摄像头仍在取流。完整停止请用 `bun run stop`，异常退出的资源清理见[米家资源释放](mijia.md#资源释放)。

### Docker 摄像头网络

摄像头需与运行服务的机器局域网互通。go2rtc 容器使用 host 网络：

- **macOS / Docker Desktop**：在 Settings → Resources → Network 开启 **Enable host networking** 和 **Use kernel networking for UDP**，应用并重启；允许 Docker 访问 macOS“本地网络”。需要 Docker Desktop 4.34+。
- **Linux / Docker Engine**：使用宿主机网络；实际摄像头播放尚未验证。
- **Windows**：启动脚本和摄像头链路尚未验证。

启动命令会检查 macOS 的上述设置。Docker 网络设置全局生效，重启会中断其他容器；内核 UDP 可能与 VPN 冲突。详见 [Docker 网络设置](https://docs.docker.com/desktop/settings-and-maintenance/settings/#network)。

服务仅面向可信本机，尚无用户认证。数据库与 go2rtc 管理端口限制在本机访问，不应暴露到公网。摄像头用法与限制见[米家与摄像头](mijia.md)，构建说明见 [go2rtc](../docker/go2rtc/README.md)。

生产模式使用 `bun run start`，构建后把入口切到生产页面并启动 backend 和 Agent，访问 <https://localhost:8443/>；依赖服务与数据库结构需事先准备；本机数据库准备可直接运行 `bun run db:init`，它自动启动并等待数据库就绪，不启动 go2rtc 或应用。使用外部数据库部署时，执行 `bun run --cwd apps/backend db:migrate`，再运行 `bun run --cwd apps/backend db:check`，不通过本机服务管理脚本。开发与生产共用入口端口，切换模式会替换页面提供方式，不同时启动两套入口。

## 可选的本地 Langfuse

Langfuse 是模型与工具调用的追踪展示服务。它和 PostgreSQL、ClickHouse（追踪分析数据库）、Redis（任务队列）及 MinIO（对象存储）一起属于根目录的 `home-agent` Compose 项目，在 Docker Desktop 中显示于同一服务组。默认不启用，不下载或启动这些可选服务；内部各服务仍使用独立容器。需要 Docker Compose 2.20+ 的 `include` 能力。

Web 与 Worker 镜像统一固定为 `4.64.0`。更新时先备份 PostgreSQL、ClickHouse、对象存储和队列数据，再将两个镜像改为同一稳定版本并拉取、重建。服务启动会自动应用数据库迁移；升级依据见[官方升级说明](https://langfuse.com/self-hosting/upgrade)。

```sh
docker compose pull langfuse-web langfuse-worker
docker compose up -d --wait --wait-timeout 180 langfuse-entry langfuse-worker
```

重建后核对实际镜像版本、Web 的 `/api/public/health?failIfDatabaseUnavailable=true`、Worker 的 `:3030/api/health` 及后台迁移状态。只改镜像标签或 SDK 版本不表示运行中的服务已升级。备份保存在 Git 忽略的本地目录，并限制为当前用户可读；升级保留原数据卷。

在根目录 `.env` 填写以下配置：

```dotenv
COMPOSE_PROFILES=langfuse
LANGFUSE_LOCAL_SECRET=填入openssl生成的64位十六进制值
LANGFUSE_PUBLIC_KEY=pk-lf-填入一个随机UUID
LANGFUSE_SECRET_KEY=sk-lf-填入另一个随机UUID
LANGFUSE_INIT_USER_EMAIL=你的登录邮箱
LANGFUSE_INIT_USER_PASSWORD=你的登录密码
# 查看提示词、回答和工具正文时开启；默认不采集。
OTEL_INCLUDE_CONTENT=true
```

`COMPOSE_PROFILES` 是 Docker Compose 的可选服务组开关；多个 profile 用逗号分隔。运行 `openssl rand -hex 32` 生成本地部署密钥，运行 `uuidgen` 分别生成两个项目密钥后缀。不要把示例占位文本作为实际值。`LANGFUSE_LOCAL_SECRET` 用于此本机实例的数据库、队列、对象存储、登录和加密配置，已有数据后须保持不变。启用 profile 时启动命令会检查密钥格式和必填项；配置保存在 Git 忽略的 `.env`，不要提交。

执行 `bun run dev` 会启动可选服务并等待展示服务健康检查通过，首次下载与数据库初始化可能需要较长时间。打开 `http://localhost:${LANGFUSE_PORT}`（默认 3001），本地入口会使用配置的固定账号自动建立会话并进入 Home Agent 项目，无需填写登录表单。入口运行在同一个 Docker 组中，HTTP 转发使用 `httpxy`；账号密码只在入口容器与 Langfuse 之间传递，不写入网页。`LANGFUSE_AUTO_LOGIN` 默认 `true`，设置为 `false` 后使用普通登录页面。此模式面向可信本机，访问入口的本机用户均以同一个配置账号进入项目。

自动登录使用 Langfuse 当前的 NextAuth 登录接口（先取得防止跨站请求伪造的 CSRF 令牌，再提交固定账号），不修改 Langfuse 本身的认证。Langfuse 使用官方启动初始化能力创建 Home Agent 组织、项目和项目密钥；仅创建缺失资源，修改初始化字段不会重置已有账号、密码或项目密钥。自动登录要求配置与已有账号一致，不一致时入口明确返回错误，须在 Langfuse 管理已有账号后更新配置。

填写两个项目密钥且省略 `OTEL_TRACES_EXPORTER` 时，Backend 与 Agent 自动启用 Langfuse 导出；本地 profile 将默认接收地址设为 `http://localhost:3001`。显式 `LANGFUSE_BASE_URL` 优先于本地默认地址；通用 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 或 `OTEL_EXPORTER_OTLP_ENDPOINT` 用于独立 Collector，可与 Langfuse 同时启用。Langfuse 只接收 Agent 执行相关记录，通用导出保留 SDK 采样留下的常规追踪。`LANGFUSE_TRACING_ENABLED=false` 单独关闭 Langfuse 导出，`OTEL_TRACES_EXPORTER=none` 关闭全部导出；两者不关闭展示容器。配置及转发边界见[追踪说明](../packages/observability/README.md#配置)。修改配置后重启应用；已运行的应用不会因再次执行 `bun run dev` 自动重启。

可通过 `LANGFUSE_PORT` 更改页面端口，通过 `LANGFUSE_MEDIA_PORT` 更改媒体存储端口（默认 9090）；自动接收地址及 Compose 的页面和媒体地址随之更新。只有自动登录入口及媒体端口绑定本机回环地址，Langfuse Web、内部数据库和队列不直接发布宿主端口，Langfuse 数据库与家庭上下文数据库独立。Langfuse 追踪不替代摄像头检测框和筛选片段展示，采集边界见[追踪说明](../packages/observability/README.md)。

`bun run status` 显示所有依赖容器；`bun run stop` 包括已启用的 Langfuse，即使已清空 profile 也会停止其容器，并保留数据卷。关闭本地展示时先停止服务，再清空 `COMPOSE_PROFILES` 并设置 `OTEL_TRACES_EXPORTER=none`，然后重新启动。不要使用 `docker compose down -v`，它会删除数据库和追踪数据卷。

单独准备本机部署依赖时，用 `docker compose up -d --build --wait langfuse-entry langfuse-worker` 启动已配置的 Langfuse，再按生产运行说明启动应用；`bun run start` 不管理 Docker 依赖。此配置依据 [Langfuse 官方 Compose](https://langfuse.com/self-hosting/deployment/docker-compose) 与[启动初始化](https://langfuse.com/self-hosting/administration/headless-initialization)，容器启动、健康检查、初始化账号登录及项目页面已在本机验证；普通聊天及工具失败追踪已通过本机 Observations API（观测记录查询接口）核验，其余验证范围见[追踪链路](../packages/observability/README.md#追踪链路)。

## HTTPS 与 HTTP/2 入口

本机需安装 [Caddy](https://caddyserver.com/docs/install)；macOS 使用 `brew install caddy`。开发与生产浏览器统一访问 <https://localhost:8443/>，避免多个 SSE（服务端持续推送事件的连接）占满 HTTP/1.1 浏览器连接。内部 Vite、backend 与 Agent 端口仍用于服务间通信和排障。

```sh
bun --env-file=.env scripts/web-entry.ts development  # 独立启动或重载开发入口
bun run web:trust        # 首次启动后安装 Caddy 本地根证书，按系统提示授权
bun --env-file=.env scripts/web-entry.ts production   # 已构建时切换为生产页面
bun --env-file=.env scripts/web-entry.ts stop         # 只停止本项目入口
```

入口由 `scripts/web-entry.ts` 使用 Caddy 原生命令管理。`deploy/web/Caddyfile` 仅绑定回环地址，保留浏览器 Host／Origin；`/api/*` 直接转发至 backend。开发模式通过 `development.caddy` 转发页面及 WebSocket 热更新到 Vite；生产模式通过 `production.caddy` 提供 `apps/backend/dist/public`、预压缩文件和前端路由入口，API 不进入页面回退。开发及生产共用本地证书与管理实例，重载不会启动第二个入口。

`bun run stop` 先停止受管理的开发应用，让 backend 结束持续推送，再停止 Caddy，最后停止 go2rtc 和数据库。Caddy 停止或配置切换时最多等待现有 HTTP 请求 5 秒，随后关闭尚未结束的连接，避免 SSE 长连接阻止退出。停止和重载命令最多等待 15 秒，超过后终止命令并报错；这不代表 Caddy 服务本身已退出。管理接口状态查询最多等待 10 秒；超时会报错，不把仍占用管理 socket 的进程当作未运行，也不自动启动第二个入口。

证书与私钥、管理 socket（本机进程通信端点）及运行日志保存在 Git 忽略的 `config/runtime/caddy/`，目录只允许当前用户访问；管理接口不开放 TCP 端口。Caddy 使用[自动 HTTPS](https://caddyserver.com/docs/automatic-https)签发和续期 `localhost` 证书，首次信任由显式的 `web:trust` 命令完成，不跳过浏览器证书检查。不要复制私钥或把该目录提交 Git；删除证书存储后需要重新信任新根证书。开发终端退出后入口仍运行，可直接调用入口脚本的 `stop` 操作或用 `bun run stop` 关闭。

浏览器入口支持 HTTP/2，内部转发使用 HTTP/1.1；SSE 沿用 Caddy 对 `text/event-stream` 的[即时刷新](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)，不设置响应缓冲或 `flush_interval -1`，客户端离页时取消上游读取。WebRTC 媒体仍直接连接本机 go2rtc，HTTPS 入口只代理播放信令。backend 验证真实 TCP 对端为回环地址，单独接纳 `localhost:8443` Host 与 `https://localhost:8443` Origin，不信任转发头；Agent 的访问范围不变。

## 服务连接

Docker 数据库通过 `.env` 的 `POSTGRES_PORT` 映射到本机，容器内端口固定为 5432；`DATABASE_URL` 的端口须与 `POSTGRES_PORT` 一致。backend 和 Agent 运行在本机，监听地址分别由 `.env` 的 `BACKEND_HOST` / `BACKEND_PORT`、`AGENT_HOST` / `AGENT_PORT` 设置，无需 Docker 端口映射。Caddy 入口监听 `127.0.0.1:8443` 与 `[::1]:8443`，浏览器使用 `https://localhost:8443`；前端开发服务器监听内部 `127.0.0.1:5173`，API 转发使用 backend 的环境变量配置。go2rtc 使用 host 网络，不配置 `ports` 映射；启动命令统一使用本机 1984（API）、8554（RTSP）和 8555（WebRTC）端口。

Agent 的 `BACKEND_URL` 默认 `http://127.0.0.1:3000`，用于后台上下文订阅和只读历史查询；Backend 监听地址或端口自定义时须显式设置该地址。接收不要求模型配置，诊断入口见[Agent README](../apps/agent/README.md#当前数据接收与只读历史客户端)。

backend 与 Agent 分别运行在独立进程中，通过 HTTP 通信，各自拥有内存与 JS 主线程。`bun run dev` 和 `bun run start` 统一启动两者，不将 Agent 导入 backend 进程，也不共享家庭状态对象。

统一启动是开发便利，不表示 backend 依赖 Agent 在线。当前摄像头预览与本地检测不调用 Agent，也不要求 模型或提供商凭据；Agent 不在线时聊天不可用、服务检查显示该项不可达，不阻止已配置的本地检测。

backend 首次启动在仓库根目录创建 `config/config.yaml` 与相邻的 `config.schema.json`，已有 YAML 不覆盖。默认路径不受启动工作目录影响，源码与构建入口使用同一文件；整个 `/config/` 忽略 Git。

```yaml
# yaml-language-server: $schema=./config.schema.json
services:
  agent:
    url: http://127.0.0.1:1811
  go2rtc:
    url: http://127.0.0.1:1984
```

连接 YAML 仅保存服务地址，不保存账号凭据或运行状态；数据库、远程语言模型服务与追踪使用各自的环境变量。本地目标检测模型固定放在 `apps/backend/models/det_4C.onnx`，由感知模块内部常量引用。地址必须是无内嵌凭据的 HTTP(S) 服务根地址，可带端口，不支持路径前缀、query 或 fragment。go2rtc 自身的监听与用户流配置使用 `config/go2rtc/go2rtc.yaml`；米家摄像头共享流由 backend 在 go2rtc 内存中创建，不写入这两个文件。原生／容器模式通过启动命令切换，无需修改地址。

服务设置页与手动编辑使用同一文件。配置查询、聊天转发和连接检查每次重新读取文件，内容变化后重新校验，下次请求生效；在途请求沿用开始时读取的地址。米家媒体连接由后台每 3 秒检查配置变更并更新连接。文件损坏或无法读取时，相关调用暂停，页面显示错误；修复后下次请求恢复，无需重启。backend 的 `/api/health` 独立于连接配置。

配置必须完整，拒绝未知字段、重复 YAML key、别名引用和超过 64 KiB 的文件。schema 导出或写入失败只提示，不影响有效 YAML 的读取。保存尽量保留注释并原子替换文件，需要可写目录，单文件挂载不满足条件；只读文件或目录仍可读取，页面禁用保存。手动编辑与页面保存应错开，当前没有并发修改冲突检测。

### 自定义配置路径

backend 支持 `--config <path>`，schema 放在指定 YAML 旁边。从仓库根目录启动：

```sh
bun --env-file=.env apps/backend/src/main.ts --config ./local-config/config.yaml
# 先运行 bun run build，再使用构建入口
bun --env-file=.env apps/backend/dist/main.js --config ./local-config/config.yaml
```

相对路径按 **backend 进程启动目录** 解析。例如在 `apps/backend` 中执行 `bun run dev --config ../../local-config/config.yaml`。Turbo 转发参数也按子进程目录解析；使用绝对路径可避免歧义。自定义配置目录请自行忽略 Git。

### 连接状态与访问范围

服务设置页约每 10 秒检查 Agent `/health` 与 go2rtc `/api`，每项限时 3 秒。**已连接只表示服务接口可用，不代表模型、米家授权或摄像头出流已就绪。** go2rtc `/api` 的 `revision` 是构建版本信息，与米家的媒体运行标识无关。米家绑定、共享流和浏览器出帧的区别见[组件与资源](mijia.md#组件与资源)。

设置页管理已运行服务的地址，并提供摄像头接入重试；扫码、重新扫码与退出登录见[米家与摄像头](mijia.md)。接口结构和探测协议见 [Backend](../apps/backend/README.md#连接配置与探测)。

配置、服务检查、米家和聊天接口要求 TCP 对端为 loopback，Host 与浏览器 Origin 为允许的本机地址和端口；不信任转发头，不开放 CORS。修改监听地址不会放宽限制。Agent 的 `/api/*` 同样限制本机访问，不能通过直连绕过 backend 边界。

## 单独启动与检查

根目录保留完整服务操作和仓库质量检查；单应用开发、数据库结构生成／应用／浏览／检查使用所属应用命令，独立入口操作直接调用脚本。只读数据库检查运行 `bun run --cwd apps/backend db:check`。

```sh
bunx turbo run dev --filter=@home-agent/web
bun run --cwd apps/backend dev
bunx turbo run dev --filter=@home-agent/agent-host
bun run check
bun run build
```

单独启动应用不会管理依赖，也不纳入 `bun run stop` 的进程管理。

仅开发 backend 感知时，先准备 go2rtc、已初始化的 backend 数据库、米家授权、FFmpeg 和感知配置，再运行 `bun run --cwd apps/backend dev`；需要页面时按下方 Web 启动命令运行。根目录 `db:init` 应用当前迁移集合并检查 backend 数据库，`db:migrate` 同样使用原生 Drizzle 应用和检查；Agent 不需要数据库初始化。

`bun run check` 执行格式、lint 和类型检查，覆盖各 workspace 及根目录 `scripts/`。共享 lint 与 TypeScript 配置分别由 `@home-agent/oxlint-config` 和 `@home-agent/typescript-config` 提供，各包通过 workspace 依赖引用；Turbo 负责检查任务和构建依赖，前端构建先完成类型检查。
