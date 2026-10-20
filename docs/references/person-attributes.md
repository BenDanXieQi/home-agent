# 人体可见属性模型参考

PP-Human 的轻量人体属性模型在固定 Real28 人体裁剪上的离线对照未观察到成员归因增益，当前不接入。属性一致不能使未达到人体重识别（ReID）门槛的身份通过；高分也不能证明属性可见或正确。

[官方模型说明](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/deploy/pipeline/docs/tutorials/pphuman_attribute.md)提供基于 PP-LCNet_x1_0 的人体属性模型。模型预处理和标签解释应以资产配置、[官方预处理](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/deploy/python/preprocess.py)及[官方后处理](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/deploy/pipeline/pphuman/attr_infer.py)为准；普通图像分类权重不能替代人体属性模型。官方仓库采用 [Apache 2.0 许可](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/LICENSE)。

只有具备独立属性标注、明确的归因问题及新的实测增益时才重新考虑接入。公开静态裁剪不能验证人脸确认、参照期限或家庭活动，官方 GPU 性能不能用于本机 CPU 预算。家庭外观归因仍受[校准与验收边界](../perception.md#外观校准输入与验收边界)限制。
