# 目标检测模型资产

目标检测固定使用本目录的 `det_4C.onnx`。`src/perception/detection/model.ts` 通过内部常量定位文件，模型路径不作为调用参数、命令参数或环境变量。

- 来源：MiLoCo `backend/miloco/src/miloco/perception/models/det_4C.onnx`。
- 参考提交：`cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8`。
- SHA-256：`eb55fff61225c1e4d90312a0f70f675ce19632bae1b51b948a3c8dc96765bf2f`。
- 原项目许可：[LICENSE.md](LICENSE.md)。该文件保留原文，适用约束见其内容。

部署 backend 时一并携带 `models/` 与 `dist/`，保持它们位于同一目录下。源码推理入口与构建后的 `dist/perception/compute/inference-worker.js` 均读取同一份模型；运行时不下载模型。
