# 人体可见属性模型参考

PP-Human 的轻量人体属性模型用于[人物属性唯一归因](../perception.md#人物属性唯一归因)：人体外观判断与家庭登记性别匹配，且该性别只登记一位成员时，产生未确认的推测。它不修改人体重识别（ReID）的匹配分数和接纳门槛。

[官方模型说明](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/deploy/pipeline/docs/tutorials/pphuman_attribute.md)提供基于 PP-LCNet_x1_0 的人体属性模型。模型预处理和标签解释应以资产配置、[官方预处理](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/deploy/python/preprocess.py)及[官方后处理](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/deploy/pipeline/pphuman/attr_infer.py)为准；普通图像分类权重不能替代人体属性模型。官方仓库采用 [Apache 2.0 许可](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/LICENSE)。

固定 Real28 人体裁剪上的离线对照未观察到衣着属性对 ReID 接纳的增益；该结论不评估家庭登记性别唯一规则。公开静态裁剪不能验证人脸确认、参照期限或家庭活动，属性高分也不证明属性正确或身份已确认。官方 GPU 性能不能用于本机 CPU 预算。模型转换与资产见[模型说明](../../apps/backend/models/README.md#人体可见属性模型)，家庭外观归因的验证限制见[校准与验收边界](../perception.md#外观校准输入与验收边界)。
