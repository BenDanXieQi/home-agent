# 本地运行

```sh
bun run dev                    # 沿用已选模式，首次默认 docker
bun run dev --mode native      # 使用本机 go2rtc
bun run dev --mode docker      # 使用 Docker go2rtc
bun run stop                   # 停止应用和依赖，保留数据
bun run status                 # 查看运行状态
```

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

backend 首次启动生成 `config/config.yaml`，修改后下次请求生效。默认 Agent 地址为 `http://127.0.0.1:1811`，go2rtc 地址为 `http://127.0.0.1:1984`。详细配置见[服务连接配置](service-connections.md)。

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
