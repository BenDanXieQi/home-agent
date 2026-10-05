# 人体可见属性离线评估

## 采用判断

PP-Human 的轻量人体属性模型已在固定 Real28 人体裁剪上完成原生 Paddle CPU 离线评估。冻结的保守属性候选与仅 ReID 的接纳结果完全相同，没有观察到成员归因增益，当前不接入。线上仍不新增属性模型、调用、原图保留或成员资料字段；正式外观归因仍受[剩余校准与验收](../plans/member-attribution.md)限制。

## 官方资产与执行契约

[官方模型说明](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/deploy/pipeline/docs/tutorials/pphuman_attribute.md)提供 `PPLCNet_x1_0_person_attribute_945_infer.zip`，采用 StrongBaseline 的人体属性任务和 PP-LCNet_x1_0 网络。固定归档 SHA-256 为 `d1d28223d1ff7a1b0b1ff2e9af6747df143c228ec6e9bd78e7f91ab6b2ced5df`。包内是 `inference.pdmodel` 和 `inference.pdiparams`，本次没有转换或验证 ONNX。普通图像分类权重不能替代此模型。

按包内 `infer_cfg.yml` 和[官方预处理](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/deploy/python/preprocess.py)解码 RGB，线性缩放到高256、宽192，不保持宽高比；float32 乘1/255，减 mean `[0.485,0.456,0.406]`，除 std `[0.229,0.224,0.225]`，转换为 CHW。读取原 sigmoid 输出，不再次 sigmoid。[官方后处理](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/deploy/pipeline/pphuman/attr_infer.py)会强制选择某些类别；本评估不沿用这些展示字符串。

26项输出中，年龄19–21和性别22即时丢弃，不保存、不用于归因；保存其他22项可见字段的原始分数。标签没有通用衣服颜色。官方仓库[许可](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/LICENSE)为 Apache 2.0，本机许可文件 SHA-256 为 `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`；模型包未附单独许可文本。资产、配置、来源源码和许可指纹均随原始分数保存，许可文本保存在本机资产目录。

## 评估依据与适用边界

冻结的 Real28 对照仅检查 ReID 已接纳目标，明确的袖长与下装同时不一致时改为未知；数值高分不证明属性可见或正确。协议、完整分母、固定结果、代表图核对与本机资源观测集中在[人体可见属性评估](../../apps/backend/scripts/perception-evaluation/README.md#人体可见属性对照)。保守候选没有改变接纳结果，当前不接入；此判断不表示其他素材或其他候选也必然没有收益。

Real28 没有独立姿态、遮挡、低光、裁剪完整度或属性真值，公开静态裁剪不提供人脸确认、参照期限及家庭活动证据。原生 CPU 的运行库线程数、进程内存和整条预处理／推理成本须按实测环境解释，不能将官方 V100 TensorRT FP16 的速度用于本机预算。若后续考虑采用，仍需独立标注与基础归因问题、可复现增益和专项运行验收，条件只在[成员归因计划](../plans/member-attribution.md#6-属性模型的后续条件)维护。
