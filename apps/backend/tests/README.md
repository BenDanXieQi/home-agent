# Backend 测试

使用 Bun 原生运行器测试后端；Web 业务逻辑由独立的 Vitest Node 环境运行。仓库根目录执行 `bun run test` 运行两端测试，不需要构建或启动应用。

`bunfig.toml` 保留 Bun 脚本 shell，但尊重 CLI 的解释器声明，让 Vitest 使用 Node；后端和应用脚本需要 Bun 时显式调用 `bun`。不要用 `bun --bun` 强制运行 Vitest。

```sh
bun run --cwd apps/backend test
bun test ./apps/backend/tests/device-access/account
bun run --cwd apps/web test
```

范围依据 [设备接入代码职责参考](../../../docs/device-access-code-reference.md) 和 [Step 1](../../../docs/plans/household-steps/01-device-access/README.md)。先从“错误的状态、身份、时间或部分成功会导致什么结果”选择场景，再通过生产入口验证，不设覆盖率门槛。

每个保留用例应对应一个独立业务故障。第三方 schema 的同类数值枚举、仅让 mock 抛错再断言原样返回，以及已被真实所有者集成用例覆盖的手工状态门禁，不另立测试。并发测试先等待外部 I/O 门闩确认目标阶段已开始，再触发取消、替换或认证拒绝；结果同时检查持久凭据、活动身份和资源资格。

| 测试目录                       | 主要契约与反例                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `device-access/account`        | 完整 MiCloud＋OAuth 会话、保存后接纳、候选失败隔离、显式空家庭、扫码取消/重复验证、续期合并、Retry-After、认证拒绝与退出失败 |
| `device-access/properties`     | 同步 readable 预检、150 项串行预算、逐项成功/失败/缺值、来源时间、取消与旧作用域、认证停止余批、稳定来源限流                 |
| `device-access/protocols`      | 家庭分页和归属、云端属性请求、公开规格共享请求、独立取消和可选翻译失败                                                       |
| `device-access/devices`        | 目录安全投影、家庭范围与设备撤销、保存失败候选隔离、在途目录取消                                                             |
| `device-access/specifications` | 活动规格共享、刷新或容量拒绝保留旧能力/URN/版本、引用消失取消迟到结果                                                        |
| `device-access/observations`   | topic/载荷身份、早到包与 SUBACK 区别、共享观察取消/重加、订阅退订统一配额、旧代隔离、认证与 ACL、目录通知防抖                |
| `device-access/media`          | 独立 viewer、双镜头源身份与局部失败、预约期限、幂等协商、立即撤销资格、远端清理重试、离线目录提示、撤销后独立清理            |
| `device-access/http`           | Hono 本机访问边界、公共/私有状态隔离、命令版本、旧 epoch、输入预算、清理失败响应与 204                                       |
| `device-access/integration`    | 单家庭属性与账号目录隔离；续期保留来源/限流并撤销旧读取；跨账号资源撤销；提交期间取消/退出及 OAuth 拒绝；媒体安装失败隔离    |

编写约定：

- 测试文件使用 `*.test.ts`，按功能组织在此目录下，使用 `bun:test`。
- HTTP 测试创建独立 `createMijiaRoutes()` 与真实 service/runtime，使用 Hono 的 `app.request()` 校验状态码、响应头与响应体；显式提供 Bun peer 信息，不跳过本机访问中间件。
- 显式注入固定环境和必要依赖，避免依赖本机环境、真实配置文件或外部服务。
- 不导入 `src/main.ts`；它负责启动服务和初始化资源。
- `support/` 提供假账号、规格、存储和 Promise 屏障；MQTT/媒体的协议替身留在各领域目录。类型从生产 schema 和方法推导，不复制领域类型。
- `support/household-harness.ts` 装配真实家庭与账号所有者，提供精确的持久写入门闩和扫码/STS/OAuth 供应商响应回放。联合竞态通过公开入口触发，不直接修改内部账号或认证状态。
- 优先保持领域对象真实，仅替换云请求、SDK、存储等边界。媒体私有 API 使用随机端口的 loopback HTTP peer，不依赖真实 go2rtc。所有凭据均为假数据。
- 竞态使用 Promise 屏障，时间策略使用假时钟；每个用例清理账号、定时器、观察、server 和 spy。使用全局 spy 的 Bun 测试不得标记 `test.concurrent`。
- Bun 的异步 `expect(...).rejects` 必须 `await`；其声明返回 `void` 导致 lint 误报，只在测试文件关闭 `typescript/await-thenable`。

这些测试验证确定性业务契约与协议边界，不测试 React UI，不执行 Go overlay、真实供应商请求、数据库迁移或实机出帧验收。已实现的家庭运行时只在设备接入所需边界参与；Step 3 的自动采集、补读、latest 仲裁和规则不属于测试范围。违反契约的实现通过普通失败测试暴露，不用跳过或修改预期掩盖。

参考 [Hono 测试指南](https://hono.dev/docs/guides/testing)。新增测试前需遵循仓库规则，取得用户明确许可。
