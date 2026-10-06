# Backend 测试

使用 Bun 原生运行器测试后端；Web 业务逻辑由独立的 Vitest Node 环境运行。每次修改只运行直接相关的最小文件范围，不默认运行全量测试；新增测试须先取得用户明确许可。不需要构建或启动应用。

`bunfig.toml` 保留 Bun 脚本 shell，但尊重 CLI 的解释器声明，让 Vitest 使用 Node；后端和应用脚本需要 Bun 时显式调用 `bun`。不要用 `bun --bun` 强制运行 Vitest。

使用本机 HTTP 服务的测试需要允许监听本机回环地址（如 `127.0.0.1`）的随机端口，包括依赖 `support/household-harness.ts` 的家庭与集成测试、米家媒体测试、感知事件流和音频生命周期测试。受限沙箱可能让 `Bun.serve({ port: 0 })` 报 `EADDRINUSE`；此处 `0` 表示由系统分配端口，不能仅凭该错误认定端口被占用。遇到这类初始化失败，应在允许本机监听的执行环境中重跑原失败文件，再判断业务断言；不要通过固定端口、跳过用例或修改断言掩盖环境限制。

```sh
bun test ./apps/backend/tests/household/lifecycle.test.ts
bun run --cwd apps/web test -- tests/modules/mijia/commands.test.ts
```

本文的设备清单包含家庭、房间、设备及其归属；它与下方按代码路径列出的测试文件目录不同。范围依据 [Backend 模块职责](../README.md#目录与约定)、[米家来源契约](../../../docs/contracts/mijia.md) 和[家庭运行时业务行为](../../../docs/contracts/household-runtime.md)。先从“错误的状态、身份、时间或部分成功会导致什么结果”选择场景，再通过生产入口验证，不设覆盖率门槛。

每个保留用例应对应一个独立业务故障。第三方 schema 的同类数值枚举、仅让 mock 抛错再断言原样返回，以及已被真实资源管理模块的集成用例覆盖的重复状态检查，不另立测试。并发测试先等待外部 I/O 的等待信号确认目标阶段已开始，再触发取消、替换或认证拒绝；结果同时检查持久凭据、活动身份和资源资格。

| 测试目录                   | 主要契约与反例                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mijia/account`            | 完整 MiCloud＋OAuth 会话、保存后采用新会话、新会话准备失败不影响当前会话、首次固定绑定、扫码取消/重复验证、续期合并、Retry-After、认证拒绝与退出失败                   |
| `mijia/properties`         | 同步 readable 预检、每批最多 150 项且串行执行、逐项成功/失败/缺值、来源时间、取消与旧作用域、认证停止余批、稳定来源限流                                                |
| `mijia/protocols`          | 家庭分页和归属、云端属性请求、公开规格共享请求、独立取消和可选翻译失败                                                                                                 |
| `mijia/devices`            | 设备清单只公开允许字段、家庭范围与设备撤销、待保存清单失败不替换现有清单、取消正在进行的清单请求                                                                       |
| `household`                | 控制状态与资料接纳、满额下规格任务终态、首次保存与设备清单获取失败重试、缓存失败仍运行、缺详情设备隔离、设备动态增减与最小增量更新、旧操作结果隔离、数据库提交结果确认 |
| `household/specifications` | 活动规格共享、任务状态不受容量阻挡、旧展示资料与当前读取资格分离、刷新失败保留旧 URN/版本、引用消失取消迟到结果                                                        |
| `mijia/observations`       | topic/载荷身份、早到包与 SUBACK 区别、共享观察取消/重加、订阅退订统一配额、旧代隔离、认证与 ACL、合并连续设备清单变更通知                                              |
| `mijia/media`              | 独立 viewer、双镜头源身份与局部失败、预约期限、幂等协商、立即撤销资格、远端清理重试、设备清单中的离线提示、撤销后独立清理                                              |
| `mijia/http`               | Hono 本机访问边界、公共/私有状态隔离、命令版本、旧 epoch、输入数据大小限制、清理失败响应与 204                                                                         |
| `integration`              | 单家庭属性与账号设备清单隔离；续期保留来源/限流并撤销旧读取；异账号拒绝、同账号新会话的资源撤销；提交期间取消/退出及 OAuth 拒绝；媒体安装失败隔离                      |

目录按生产模块职责划分：`mijia/` 测试米家模块，`household/` 测试家庭领域，`integration/` 验证跨模块协作；`support/` 保存共享测试辅助。

编写约定：

- 测试文件使用 `*.test.ts`，按功能组织在此目录下，使用 `bun:test`。
- HTTP 测试创建独立 `createMijiaRoutes()` 与真实 service/runtime，使用 Hono 的 `app.request()` 校验状态码、响应头与响应体；显式提供 Bun peer 信息，不跳过本机访问中间件。
- 显式注入固定环境和必要依赖，避免依赖本机环境、真实配置文件或外部服务。
- 不导入 `src/main.ts`；它负责启动服务和初始化资源。
- `support/` 提供假账号、规格、存储和 Promise 屏障；MQTT/媒体的协议替身留在各领域目录。类型从生产 schema 和方法推导，不复制领域类型。
- `support/household-harness.ts` 使用真实家庭与账号管理模块，提供精确控制数据库写入时机的等待信号和扫码/STS/OAuth 供应商响应回放。联合竞态通过公开入口触发，不直接修改内部账号或认证状态。
- 优先保持领域对象真实，仅替换云请求、SDK、存储等边界。媒体私有 API 使用随机端口的 loopback HTTP peer，不依赖真实 go2rtc。所有凭据均为假数据。
- 竞态使用 Promise 屏障，时间策略使用假时钟；每个用例清理账号、定时器、观察、server 和 spy。使用全局 spy 的 Bun 测试不得标记 `test.concurrent`。
- Bun 的异步 `expect(...).rejects` 必须 `await`；其声明返回 `void` 导致 lint 误报，只在测试文件关闭 `typescript/await-thenable`。

这些测试验证确定性业务契约与协议边界，不测试 React UI，不执行 Go overlay、真实供应商请求、数据库迁移或实机出帧验收。家庭运行时的规则映射与证据边界见[家庭功能测试](household/README.md)。`household/device-reports.test.ts` 通过真实家庭状态机和可控单调时钟，验证报告值、来源与有效期对房间查询、当前值有效性和可信变化的影响；`integration/device-online.test.ts` 通过真实账号、家庭运行时、米家采集适配器与读取入口，验证设备清单初始化在线状态、离线时不请求供应商、未实测型号的合法上线通知恢复读取以及刷新修正遗漏状态；MQTT 重连触发清单刷新的行为由 `mijia/observations/directory-notifications.test.ts` 验证。测试不证明自动补读的全部调度分支、模型调用或真实设备的上报保证。违反契约的实现通过普通失败测试暴露，不用跳过或修改预期掩盖。

参考 [Hono 测试指南](https://hono.dev/docs/guides/testing)。新增测试前需遵循仓库规则，取得用户明确许可。

## 声音观察与推理所有权

`perception/audio-observations.test.ts` 通过真实窗口存储入口验证人声和宠物结果在关闭后接纳、重复交付、跨窗分析上下文、撤权、媒体到期与容量上限。`perception/audio-inference.test.ts` 仅替换原生子进程边界，验证慢推理期间采样继续推进、待处理上下文替换、取消和重建以及独立 CPU 预留；不替换领域判断，也不用于证明模型准确率。

```sh
bun test apps/backend/tests/perception/audio-observations.test.ts apps/backend/tests/perception/audio-inference.test.ts
```

## 音频业务回归

音频测试从可观察的业务结果出发，不以分支覆盖或参数校验数量作为目标：

- `perception/audio-facts.test.ts`：同一声音不因传输分块或另一台摄像头的活动而改变事实；新运行不继承旧模型状态；清晰语音与静音可区分；模型不可用时仍提供能量，但不宣称无人声。
- `perception/audio-lifecycle.test.ts`：家庭访问撤销后立即移除事实；单摄卡住不影响其他来源；陈旧媒体不能刷新事实有效期；无音轨与安静不同；初始化中关闭释放资源。通过真实 HTTP、FFmpeg、IPC 和模型执行，不替换分析结果。
- `perception/audio-time.test.ts`：Opus 解码跳过起始采样后，观察时间不能被提前到首包接收时间。
- `perception/audio-cleanup.test.ts`：操作系统迟报退出时，前次超时不能使后续清理永久失败，也不能再次向已经失去所有权的进程组发送信号。仅操作系统进程边界使用替身。
- `perception/stream-isolation.test.ts`：慢浏览器不能拖住其他订阅，关闭后释放订阅名额；事实过期后新加入的观察者应读到当前有效性，即使没有新媒体事件；使用真实本机 HTTP 与 SSE。

```sh
bun test apps/backend/tests/perception/audio-facts.test.ts \
  apps/backend/tests/perception/audio-lifecycle.test.ts \
  apps/backend/tests/perception/audio-time.test.ts \
  apps/backend/tests/perception/audio-cleanup.test.ts \
  apps/backend/tests/perception/stream-isolation.test.ts
```

上述音频测试需要本机 FFmpeg 和固定 Silero 资产；不读取真实账号凭据或操作摄像头。`speech-16k.pcm` 是本机语音合成生成的英文句子，16 kHz 单声道 int16，小端序，无家庭录音；`opus-silence.ogg` 是 Go 音频适配器封装的交替 20/40 ms Opus 静音包。样本来源及再生成说明见同目录 [音频样本](perception/fixtures/audio-fixtures.md)。

Go overlay 的 `TestAudioTimelineSurvivesOpusPackaging` 用真实 FFmpeg 检查封装前后的声音时长；`TestMalformedAudioDoesNotInterruptVideo` 检查异常音频后的正常视频仍可交付。在应用补丁并复制 overlay 的 go2rtc 源码内运行这两项，环境需要 Go 与 FFmpeg，不运行整个上游测试集。

性能、压力和实机验证入口见 [感知评估](../scripts/perception-evaluation/README.md#音频链路与资源)。这类结果不能替代回归断言，也不能用一次短时采样证明长期部署容量。

## 视频观察与共用原生监督

`perception/video-observations.test.ts` 从真实窗口存储入口核对检测、跟踪、身份的到达顺序、完整帧匹配、重复冻结、关闭期限与来源撤销。`perception/native-inference.test.ts` 在操作系统边界控制超时与 IPC 失败，核对退出确认重试；真实身份子进程用缺失资产验证局部模型不可用不会破坏通信。`perception/reid-native.test.ts` 验证真实 ReID 输出、硬期限和退出。仅运行受改动影响的文件，不以这些检查替代摄像头长时验收。

```sh
bun test apps/backend/tests/perception/video-observations.test.ts apps/backend/tests/perception/native-inference.test.ts apps/backend/tests/perception/reid-native.test.ts
```
