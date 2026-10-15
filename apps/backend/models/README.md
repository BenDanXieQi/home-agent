# 本地感知模型资产

- 来源：MiLoCo `backend/miloco/src/miloco/perception/models/det_4C.onnx`。
- 参考提交：`cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8`。
- SHA-256：`eb55fff61225c1e4d90312a0f70f675ce19632bae1b51b948a3c8dc96765bf2f`。
- 原项目许可：[LICENSE.md](LICENSE.md)。该文件保留原文，适用约束见其内容。

部署 backend 时一并携带 `models/` 与 `dist/`，保持它们位于同一目录下。源码推理入口与构建后的 `dist/perception/compute/inference-worker.js` 均读取同一份模型；运行时不下载模型。

## 人体外观模型

- 来源：同一参考提交的 `backend/miloco/src/miloco/perception/models/human_body_reid_v2.onnx`。
- SHA-256：`dc70121835336bcd342be0d3f5baba350e94c605b8da886a6efd2f3357fa3f29`，初始化时必须匹配。
- 实际输入：`input:0`，float32 `[1,3,192,96]`；人体原帧裁切线性缩放，BGR 通道顺序，像素不除以 255。
- 实际输出：`head/out_emb:0`，float32 `[1,1,1,128]`；展平后做 L2 归一化。零长度或非有限特征拒绝使用。
- 许可依据仍为同目录 [LICENSE.md](LICENSE.md)，未发现该模型单独的许可声明。

构建后的 `dist/perception/tracking/reid-entry.js` 使用同一份资产；运行时不下载。加载失败只使人体外观特征不可用，基础检测继续运行。

## 人声检测模型

源码及构建后的 `dist/perception/audio/process-entry.js` 使用同一份资产。运行时不下载；模型缺失、哈希不符或推理失败只将 VAD（语音活动检测）报告为不可用，音频能量与视频检测继续运行。

## 语音转写模型

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

## 猫狗声音模型

- 固定官方资产包：`sherpa-onnx-zipformer-small-audio-tagging-2024-04-15.tar.bz2`，来源为 [sherpa-onnx 音频分类发布](https://k2-fsa.github.io/sherpa/onnx/audio-tagging/pretrained_models.html)。
- 模型 SHA-256：`69304b8a1b96bbe6b7d16c24079f0732c65faf3568a14cb82a8238c709afe76c`。
- 标签 SHA-256：`cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429`。
- 模型包 README 声明 Apache-2.0；部署保留其中 README、来源和适用的 [Apache-2.0 许可](PET-SOUNDS-LICENSE)。
- 输入固定单声道 16 kHz float32 PCM，特征处理和 527 类分数由现有 `sherpa-onnx-node@1.13.8` 计算，使用 CPU 单线程。本项目使用四秒完整窗口，分类结果没有精确事件时间定位。

准备资产：

```sh
mkdir -p data/models apps/backend/models/pet-sounds
curl -fL --retry 2 -o data/models/pet-sounds.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-zipformer-small-audio-tagging-2024-04-15.tar.bz2
tar -xjf data/models/pet-sounds.tar.bz2 --strip-components=1 -C apps/backend/models/pet-sounds
```

源码和构建后的 `dist/perception/pet-sound/process-entry.js` 使用同一资产布局。部署启用分类时携带这两个资产与许可；可以省略未使用的浮点模型和示例音频。配置、接纳规则、模型限制与验证范围见[猫狗声音识别与捕获](../../../docs/perception.md#猫狗声音识别与捕获)。
