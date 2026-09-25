# 服务连接配置

backend 首次启动在仓库根目录自动创建 `config/config.yaml` 与相邻的 `config.schema.json`，无需复制示例。整个 `/config/` 忽略 Git。已有 YAML 不覆盖；默认路径不受启动工作目录影响，仓库内 `src` 与 `dist` 入口使用同一文件。

此文件只保存服务地址；go2rtc 自身的监听与用户流配置位于 `config/go2rtc/go2rtc.yaml`。本项目的米家摄像头共享流由 backend 通过内部 API 在 go2rtc 内存中创建，不写入这两个 YAML 文件。原生／容器模式统一使用 `http://127.0.0.1:1984`，通过启动命令互斥切换，不通过修改地址切换。本机启动和配置模板见[本地基建](running.md)。

```yaml
# yaml-language-server: $schema=./config.schema.json
services:
  agent:
    url: http://127.0.0.1:1811
  go2rtc:
    url: http://127.0.0.1:1984
```

字段、默认值、运行时校验与编辑器 schema 来自同一套 Zod 定义。schema 导出或写入失败只提示，不影响有效 YAML 的读取。输入必须完整，拒绝未知字段、重复 YAML key、别名引用及超过 64 KiB 的文件。

服务设置页保存和手动编辑使用同一文件。每次配置查询、聊天转发和状态检查重新读取文件；内容完全相同时复用已校验的 YAML 解析结果，内容变化则重新解析。缓存不跳过文件访问及大小检查，手改后下次请求生效，在途请求沿用开始时读取的地址。米家媒体连接由后台每 3 秒独立检查配置变更并自动迁移，不依赖页面轮询。文件损坏或无法读取时，相关调用暂停，页面显示错误；修复后下次请求恢复，不需重启或 reload。backend 的 `/api/health` 始终独立。

地址必须是无内嵌凭据的 HTTP(S) 服务根地址，可带端口和根路径 `/`，不支持路径前缀、query 或 fragment。保存用 `yaml` Document API 尽量保留注释，再用 `write-file-atomic` 原子替换。手动编辑与 Web 保存应错开，不提供并发修改冲突检测。只读文件或目录仍可读取，页面禁用保存；权限在每次请求重新检查。

## 指定文件

支持 `--config <path>`，相对路径按 **backend 进程启动目录** 解析，schema 始终放在指定 YAML 旁边。从仓库根目录启动独立 backend：

```sh
bun --env-file=.env apps/backend/src/main.ts --config ./local-config/config.yaml
# 先运行 bun run build，再使用构建入口
bun --env-file=.env apps/backend/dist/main.js --config ./local-config/config.yaml
```

在 `apps/backend` 中运行 `bun run dev --config ../../local-config/config.yaml` 时，相对路径从该目录解析。Turbo 转发参数也按子进程目录解析；使用绝对路径可避免歧义。自定义配置目录请自行忽略 Git。

Agent 地址由 YAML 中的 `services.agent.url` 配置。数据库、模型、追踪等参数使用各自的环境变量。

## 接口与连接状态

| 接口                       | 行为                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /api/config`          | 返回 `{ config, writable, path }`，或配置错误                                                             |
| `PUT /api/config`          | 接收完整配置 JSON（最多 16 KiB），保存后返回相同结构                                                      |
| `GET /api/services/status` | 返回 `{ services: { agent, go2rtc } }`，每项有 `url`、`status`、`checkedAt`、`reasonCode` 和可选 `params` |

错误格式为 `{ code, message, params?, issues?, traceId? }`；字段错误包含 `{ path, code, params? }`。配置错误返回 503，输入错误 400，只读或不可信来源 403，非 JSON 请求 415，超大请求 413，磁盘保存失败 500。页面按错误码和原因码显示中文，不依赖后端文案。统一约定见[错误处理](errors.md)。

配置、服务检查、米家及聊天接口同时校验 TCP 对端、Host 和浏览器 Origin。TCP 对端必须是 loopback（包含 IPv4 映射的 loopback 地址），无法取得对端信息时拒绝访问；Host 和 Origin 只允许本机 `localhost`、`127.0.0.1`、`[::1]` 的 backend 端口及 Vite `5173`。不信任转发头，不开放 CORS。Vite 保留浏览器 Host，JSON 修改请求另行显式校验 Origin；普通表单 CSRF 中间件不能替代此检查。修改监听地址不会放宽管理接口的对端限制。Agent 自身的 `/api/*` 入口复用相同限制，仅接受其配置端口对应的本机 Host／Origin，不能通过直连 Agent 绕过代理边界。

每次状态请求直接检查 Agent `/health` 与 go2rtc `/api`，不缓存。每项限时 3 秒、响应最多 16 KiB，支持客户端取消，拒绝重定向并检查 JSON 结构。go2rtc 响应须包含 `version`、`revision`、`host` 字符串字段，其中 `version` 和 `host` 非空；接受附加字段。Web 约每 10 秒刷新连接状态，保存时取消旧查询，避免旧结果覆盖新地址；未保存输入不被轮询覆盖。

**已连接只表示服务接口可用，不代表模型、米家授权或摄像头出流已就绪。** go2rtc `/api` 中的 `revision` 是构建版本信息，与米家状态中的媒体代次 `revision` 无关。米家绑定就绪、共享流注册和浏览器出帧的区别见[组件与资源](mijia.md#组件与资源)。

服务设置页管理已运行服务的地址，并提供摄像头接入重试；米家扫码位于登录页，重新扫码和退出登录位于侧栏账号窗口，见[米家与摄像头](mijia.md)。其他页面的连接提醒统一结合服务可达性与米家绑定状态说明影响。原子替换需要可写目录，单文件挂载不满足这一条件。连接 YAML 仅保存服务地址，不保存账号凭据和运行状态。

依据：[Hono 路由组织](https://hono.dev/docs/guides/best-practices)、[Hono 输入校验](https://hono.dev/docs/guides/validation)、[yaml Document API](https://eemeli.org/yaml/#documents)、[Zod JSON Schema](https://zod.dev/json-schema)、[write-file-atomic](https://github.com/npm/write-file-atomic)、[go2rtc v1.9.14 API](https://github.com/AlexxIT/go2rtc/blob/v1.9.14/internal/api/api.go)。

## 实现位置

- `apps/backend/src/connections/routes.ts`：连接配置 HTTP 接口。
- `apps/backend/src/connections/store.ts`：配置路径、YAML 校验、读取和原子保存。
- `apps/backend/src/connections/status.ts`：连接探测与状态接口。
- `packages/api/src/http/local-access.ts`：管理接口的 TCP 对端及 Host／Origin 校验。
- `packages/api/src/contracts/index.ts`：前后端共用的字段、默认值与响应 schema。
- `apps/web/src/features/connections/ServiceConnections.tsx`：页面编辑、保存和状态刷新。

连接检查不验证模型推理或会话持久化；这部分见[聊天人工验收](chat-verification.md)。
