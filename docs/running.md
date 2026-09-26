# 本地运行

```sh
bun run dev                    # 沿用已选模式，首次默认 docker
bun run dev --mode native      # 使用本机 go2rtc
bun run dev --mode docker      # 使用 Docker go2rtc
bun run stop                   # 停止应用和依赖，保留数据
bun run status                 # 查看运行状态
```

`bun run dev` 逐项补齐未启动的服务：Web、backend、Agent 的端口已占用时，通过 `lsof` 和 `ps` 核对监听进程的工作目录、运行入口和进程身份，只跳过本项目对应的应用；其他项目占用端口或无法确认归属时明确报错；数据库和所选模式的 go2rtc 已运行时跳过启动。进程归属检查不代表应用健康；本机须提供 `lsof` 和 `ps`。全部已启动时命令正常退出。按 Ctrl+C 只停止当前命令新启动的应用，`bun run stop` 停止本项目记录的所有开发进程及依赖，不终止单独手动启动的应用。

两种模式都需要 Docker，分别用于数据库和 go2rtc 构建／运行，无需本机安装 Go。首次构建需联网。模式切换由启动命令管理，会中断现有播放；不要同时手工启动另一套 go2rtc。

go2rtc 配置位于 `config/go2rtc/go2rtc.yaml`，运行产物和日志位于 `config/runtime/`，均不提交 Git。修改配置后用 `bun run stop`、`bun run dev` 重启。开发终端按 Ctrl+C 后依赖进程仍保持运行，但 backend 正常关闭会请求释放其 go2rtc 运行时会话和媒体资源；go2rtc 进程仍在不等于摄像头仍在取流。完整停止请用 `bun run stop`，异常退出的资源清理见[米家资源释放](mijia.md#资源释放)。

### Docker 摄像头网络

摄像头需与运行服务的机器局域网互通。go2rtc 容器使用 host 网络：

- **macOS / Docker Desktop**：在 Settings → Resources → Network 开启 **Enable host networking** 和 **Use kernel networking for UDP**，应用并重启；允许 Docker 访问 macOS“本地网络”。需要 Docker Desktop 4.34+。
- **Linux / Docker Engine**：使用宿主机网络；实际摄像头播放尚未验证。
- **Windows**：启动脚本和摄像头链路尚未验证。

启动命令会检查 macOS 的上述设置。Docker 网络设置全局生效，重启会中断其他容器；内核 UDP 可能与 VPN 冲突。详见 [Docker 网络设置](https://docs.docker.com/desktop/settings-and-maintenance/settings/#network)。

服务仅面向可信本机，尚无用户认证。数据库与 go2rtc 管理端口限制在本机访问，不应暴露到公网。摄像头用法与限制见[米家与摄像头](mijia.md)，构建说明见 [go2rtc](../docker/go2rtc/README.md)。

生产模式使用 `bun run start`，构建并启动 backend 和 Agent，访问 <http://127.0.0.1:3000/>；依赖服务与数据库迁移需事先准备。

## 服务连接

Docker 数据库通过 `.env` 的 `POSTGRES_PORT` 映射到本机，容器内端口固定为 5432；`DATABASE_URL` 的端口须与 `POSTGRES_PORT` 一致。backend 和 Agent 运行在本机，监听地址分别由 `.env` 的 `BACKEND_HOST` / `BACKEND_PORT`、`AGENT_HOST` / `AGENT_PORT` 设置，无需 Docker 端口映射。前端开发服务器监听 `127.0.0.1:5173`，API 代理使用 backend 的环境变量配置。go2rtc 使用 host 网络，不配置 `ports` 映射；启动命令统一使用本机 1984（API）、8554（RTSP）和 8555（WebRTC）端口。

backend 与 Agent 分别运行在独立进程中，通过 HTTP 通信，各自拥有内存与 JS 主线程。`bun run dev` 和 `bun run start` 统一启动两者，不将 Agent 导入 backend 进程，也不共享家庭状态对象。

backend 首次启动在仓库根目录创建 `config/config.yaml` 与相邻的 `config.schema.json`，已有 YAML 不覆盖。默认路径不受启动工作目录影响，源码与构建入口使用同一文件；整个 `/config/` 忽略 Git。

```yaml
# yaml-language-server: $schema=./config.schema.json
services:
  agent:
    url: http://127.0.0.1:1811
  go2rtc:
    url: http://127.0.0.1:1984
```

连接 YAML 仅保存服务地址，不保存账号凭据或运行状态；数据库、模型与追踪使用各自的环境变量。地址必须是无内嵌凭据的 HTTP(S) 服务根地址，可带端口，不支持路径前缀、query 或 fragment。go2rtc 自身的监听与用户流配置使用 `config/go2rtc/go2rtc.yaml`；米家摄像头共享流由 backend 在 go2rtc 内存中创建，不写入这两个文件。原生／容器模式通过启动命令切换，无需修改地址。

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

服务设置页约每 10 秒检查 Agent `/health` 与 go2rtc `/api`，每项限时 3 秒。**已连接只表示服务接口可用，不代表模型、米家授权或摄像头出流已就绪。** go2rtc `/api` 的 `revision` 是构建版本信息，与米家的媒体代次无关。米家绑定、共享流和浏览器出帧的区别见[组件与资源](mijia.md#组件与资源)。

设置页管理已运行服务的地址，并提供摄像头接入重试；扫码、重新扫码与退出登录见[米家与摄像头](mijia.md)。接口结构和探测协议见 [Backend](../apps/backend/README.md#连接配置与探测)。

配置、服务检查、米家和聊天接口要求 TCP 对端为 loopback，Host 与浏览器 Origin 为允许的本机地址和端口；不信任转发头，不开放 CORS。修改监听地址不会放宽限制。Agent 的 `/api/*` 同样限制本机访问，不能通过直连绕过 backend 边界。

## 单独启动与检查

```sh
bun run dev:web
bun run dev:backend
bun run dev:agent
bun run check
bun run build
```

单独启动应用不会管理依赖，也不纳入 `bun run stop` 的进程管理。

`bun run check` 执行格式、lint 和类型检查，覆盖各 workspace 及根目录 `scripts/`。共享 lint 与 TypeScript 配置分别由 `@home-agent/oxlint-config` 和 `@home-agent/typescript-config` 提供，各包通过 workspace 依赖引用；Turbo 负责检查任务和构建依赖，前端构建先完成类型检查。
