# Backend 测试

使用 Bun 原生运行器测试后端；Web 业务逻辑由独立的 Vitest Node 环境运行。每次修改只运行直接相关的最小文件范围，不默认运行全量测试；新增测试须先取得用户明确许可。不需要构建或启动应用。

`bunfig.toml` 保留 Bun 脚本 shell，但尊重 CLI 的解释器声明，让 Vitest 使用 Node；后端和应用脚本需要 Bun 时显式调用 `bun`。不要用 `bun --bun` 强制运行 Vitest。

```sh
bun test ./apps/backend/tests/household/lifecycle.test.ts
bun run --cwd apps/web test -- tests/modules/mijia/commands.test.ts
```

本文的设备清单包含家庭、房间、设备及其归属；它与下方按代码路径列出的测试文件目录不同。范围依据 [Backend 使用说明](../README.md)、[米家来源契约](../../../docs/contracts/mijia.md) 和[家庭运行时业务行为](../../../docs/contracts/household-runtime.md)。先从“错误的状态、身份、时间或部分成功会导致什么结果”选择场景，再通过生产入口验证，不设覆盖率门槛。

每个保留用例应对应一个独立业务故障。第三方 schema 的同类数值枚举、仅让 mock 抛错再断言原样返回，以及已被真实资源管理模块的集成用例覆盖的重复状态检查，不另立测试。并发测试先等待外部 I/O 的等待信号确认目标阶段已开始，再触发取消、替换或认证拒绝；结果同时检查持久凭据、活动身份和资源资格。

编写约定：

参考 [Hono 测试指南](https://hono.dev/docs/guides/testing)。新增测试前需遵循仓库规则，取得用户明确许可。

## 声音观察与推理所有权

```sh
bun test apps/backend/tests/perception/audio-observations.test.ts apps/backend/tests/perception/audio-inference.test.ts
```

## 音频业务回归

音频测试从可观察的业务结果出发，不以分支覆盖或参数校验数量作为目标：

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

```sh
bun test apps/backend/tests/perception/video-observations.test.ts apps/backend/tests/perception/native-inference.test.ts apps/backend/tests/perception/reid-native.test.ts
```

## 观察归档与 SD 回放

```sh
bun test apps/backend/tests/perception/history-reader.test.ts apps/backend/tests/mijia/recordings/playback.test.ts
```
