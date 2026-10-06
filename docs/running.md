# 本地运行

```sh
bun run dev                    # 沿用已选模式，首次默认 docker
bun run dev --mode native      # 使用本机 go2rtc
bun run dev --mode docker      # 使用 Docker go2rtc
bun run stop                   # 停止应用和依赖，保留数据
bun run status                 # 查看运行状态
```

`bun run dev` 启动或重载本项目的 Caddy HTTPS 入口，并逐项补齐未启动的服务：Web、backend、Agent 的端口已占用时，通过 `lsof` 和 `ps` 核对监听进程的工作目录、运行入口和进程身份，只跳过本项目对应的应用；其他项目占用端口或无法确认归属时明确报错；所选模式的 go2rtc 已运行时跳过启动；数据库通过 Compose 启动并等待健康检查通过，随后执行 backend 迁移和数据库检查，成功后才启动 HTTPS 入口和应用。已有迁移可重复执行。进程归属检查不代表应用健康；本机须提供 `lsof` 和 `ps`。全部已启动时命令正常退出。按 Ctrl+C 只停止当前命令新启动的应用，`bun run stop` 停止本项目的 HTTPS 入口、记录的所有开发进程及依赖，不终止单独手动启动的应用。

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

生产模式使用 `bun run start`，构建后把入口切到生产页面并启动 backend 和 Agent，访问 <https://localhost:8443/>；依赖服务与数据库迁移需事先准备；本机数据库准备可直接运行 `bun run db:migrate`，它自动启动并等待数据库就绪，不启动 go2rtc 或应用。使用外部数据库部署时，直接执行 backend 的数据库命令，不通过本机服务管理脚本。开发与生产共用入口端口，切换模式会替换页面提供方式，不同时启动两套入口。

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

backend 与 Agent 分别运行在独立进程中，通过 HTTP 通信，各自拥有内存与 JS 主线程。`bun run dev` 和 `bun run start` 统一启动两者，不将 Agent 导入 backend 进程，也不共享家庭状态对象。

统一启动是开发便利，不表示 backend 依赖 Agent 在线。当前摄像头预览与本地检测不调用 Agent，也不要求 `AGENT_MODEL` 或 `OPENAI_API_KEY`；Agent 不在线时聊天不可用、服务检查显示该项不可达，不阻止已配置的本地检测。

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

服务设置页与手动编辑使用同一文件。配置查询、聊天转发和连接检查每次重新读取文件，内容变化后重新校验，下次请求生效；在途请求沿用开始时读取的地址。米家媒体连接由后台每 3 秒检查配置变更并自动迁移。文件损坏或无法读取时，相关调用暂停，页面显示错误；修复后下次请求恢复，无需重启。backend 的 `/api/health` 独立于连接配置。

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

根目录保留完整服务操作和仓库质量检查；单应用开发、数据库生成／浏览／检查使用所属应用命令，独立入口操作直接调用脚本。只读数据库检查运行 `bun run --cwd apps/backend db:check`。

```sh
bunx turbo run dev --filter=@home-agent/web
bun run --cwd apps/backend dev
bun run --cwd apps/agent dev
bun run check
bun run build
```

单独启动应用不会管理依赖，也不纳入 `bun run stop` 的进程管理。

仅开发 backend 感知时，先准备 go2rtc、backend 数据库及迁移、米家授权、FFmpeg 和感知配置，再运行 `bun run --cwd apps/backend dev`；需要页面时按下方 Web 启动命令运行。根目录 `db:migrate` 只迁移并检查 backend 数据库，Agent 不需要数据库初始化。

`bun run check` 执行格式、lint 和类型检查，覆盖各 workspace 及根目录 `scripts/`。共享 lint 与 TypeScript 配置分别由 `@home-agent/oxlint-config` 和 `@home-agent/typescript-config` 提供，各包通过 workspace 依赖引用；Turbo 负责检查任务和构建依赖，前端构建先完成类型检查。
