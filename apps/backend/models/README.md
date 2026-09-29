# 目标检测模型资产

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
