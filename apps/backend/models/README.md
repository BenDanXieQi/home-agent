# 本地感知模型资产

目标检测固定使用本目录的 `det_4C.onnx`。`src/perception/detection/model.ts` 通过内部常量定位文件，模型路径不作为调用参数、命令参数或环境变量。

- 来源：MiLoCo `backend/miloco/src/miloco/perception/models/det_4C.onnx`。
- 参考提交：`cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8`。
- SHA-256：`eb55fff61225c1e4d90312a0f70f675ce19632bae1b51b948a3c8dc96765bf2f`。
- 原项目许可：[LICENSE.md](LICENSE.md)。该文件保留原文，适用约束见其内容。

部署 backend 时一并携带 `models/` 与 `dist/`，保持它们位于同一目录下。源码推理入口与构建后的 `dist/perception/compute/inference-worker.js` 均读取同一份模型；运行时不下载模型。

## 人体外观模型

摄像头人体跟踪使用 `human_body_reid_v2.onnx`，由 `src/perception/tracking/reid.ts` 定位和核验，不接受任意模型路径。它只提供外观相似性特征，不确认人物身份。

- 来源：同一参考提交的 `backend/miloco/src/miloco/perception/models/human_body_reid_v2.onnx`。
- SHA-256：`dc70121835336bcd342be0d3f5baba350e94c605b8da886a6efd2f3357fa3f29`，初始化时必须匹配。
- 实际输入：`input:0`，float32 `[1,3,192,96]`；人体原帧裁切线性缩放，BGR 通道顺序，像素不除以 255。
- 实际输出：`head/out_emb:0`，float32 `[1,1,1,128]`；展平后做 L2 归一化。零长度或非有限特征拒绝使用。
- 许可依据仍为同目录 [LICENSE.md](LICENSE.md)，未发现该模型单独的许可声明。

构建后的 `dist/perception/tracking/reid-entry.js` 使用同一份资产；运行时不下载。加载失败只使人体外观特征不可用，基础检测继续运行。

## 人声检测模型

音频链路固定使用官方 `silero_vad.onnx`，由 `src/perception/audio/silero-vad.ts` 定位并校验。模型只返回分块人声概率，不识别说话人、不识别声音类别、不转写语音。

- 来源：[Silero VAD v5.1](https://github.com/snakers4/silero-vad/tree/84768cefdf5a3852400e9d8237f7315d14b64a08)，提交 `84768cefdf5a3852400e9d8237f7315d14b64a08` 的 `src/silero_vad/data/silero_vad.onnx`。
- SHA-256：`2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`，初始化必须匹配；许可原文保存在 [SILERO-LICENSE](SILERO-LICENSE)，适用 MIT 许可。
- 官方连续接口：[OnnxWrapper](https://github.com/snakers4/silero-vad/blob/84768cefdf5a3852400e9d8237f7315d14b64a08/src/silero_vad/utils_vad.py)。本项目固定 16 kHz，每次 512 个单声道采样，前置上一块末尾 64 点；int16 值除以 32768 后输入 float32 `[1,576]`。
- 输入名 `input/state/sr`；`state` 为 float32 `[2,1,128]`，`sr` 为标量 int64 `16000`。资产元信息的动态维度为空字符串，输入固定形状由实际推理检查，不猜测其他版本。
- 输出名 `output/stateN`；实际输出分别为 float32 `[1,1]` 和 `[2,1,128]`，拒绝非有限值或范围外概率。Silero 适配器为每个音轨运行创建独立实例，拥有状态、64 点上下文和不足 512 点的余量；连续块续接，断流及运行替换后重置。模型输入缓冲区在该实例内复用。

源码及构建后的 `dist/perception/audio/process-entry.js` 使用同一份资产。运行时不下载；模型缺失、哈希不符或推理失败只将 VAD（语音活动检测）报告为不可用，音频能量与视频检测继续运行。

## 语音转写模型

可选语音转写固定使用 SenseVoice-Small INT8，通过 `src/perception/speech/model.ts` 加载 `models/sensevoice/model.int8.onnx` 与 `tokens.txt`。权重不随 Git 仓库分发，目录已忽略；运行时不下载，也不接受任意模型路径。只有启用语音并检测到持续人声后才启动识别进程。

- 原模型：[FunAudioLLM / SenseVoiceSmall](https://huggingface.co/FunAudioLLM/SenseVoiceSmall)，通义实验室；ONNX 量化资产由 [sherpa-onnx 官方模型发布](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)提供。
- 固定资产包：`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`。
- `model.int8.onnx` SHA-256：`c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`。
- `tokens.txt` SHA-256：`f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc`。
- 输入为单声道 16 kHz float32 PCM；声学特征、模型张量与解码由 `sherpa-onnx-node@1.13.8` 处理。固定 CPU、单线程、自动语言及文本规范化，输出只接纳有界文字，不将模型事件标签当作猫狗声音分类。
- 权重适用模型卡引用的 [FunASR 模型协议](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)，不沿用运行库的 Apache-2.0 许可；保留资产包中的 LICENSE、模型名称和来源。

在仓库根目录准备资产：

```sh
mkdir -p data/models apps/backend/models/sensevoice
curl -fL --retry 2 -o data/models/sensevoice.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2
tar -xjf data/models/sensevoice.tar.bz2 --strip-components=1 -C apps/backend/models/sensevoice
```

加载时分块计算并核对两个文件的哈希。源码及构建后的 `dist/perception/speech/process-entry.js` 使用相同资产布局；部署启用语音时一起携带 `models/sensevoice/`，禁用语音不要求它存在。模型缺失或损坏只使语音转写不可用，音频基础分析与视频继续；修复后可通过现有感知重试入口重试。配置及资源语义见[本地语音转写](../../../docs/perception.md#本地语音转写)。
