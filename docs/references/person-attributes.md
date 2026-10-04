# 人体可见属性离线评估

## 采用判断

PP-Human 的轻量人体属性模型已在固定 Real28 人体裁剪上完成原生 Paddle CPU 离线评估。冻结的保守属性候选与仅 ReID 的接纳结果完全相同，没有观察到成员归因增益，当前不接入。线上仍不新增属性模型、调用、原图保留或成员资料字段；正式外观归因仍受[剩余校准与验收](../plans/member-attribution.md)限制。

## 官方资产与执行契约

[官方模型说明](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/deploy/pipeline/docs/tutorials/pphuman_attribute.md)提供 `PPLCNet_x1_0_person_attribute_945_infer.zip`，采用 StrongBaseline 的人体属性任务和 PP-LCNet_x1_0 网络。固定归档 SHA-256 为 `d1d28223d1ff7a1b0b1ff2e9af6747df143c228ec6e9bd78e7f91ab6b2ced5df`。包内是 `inference.pdmodel` 和 `inference.pdiparams`，本次没有转换或验证 ONNX。普通图像分类权重不能替代此模型。

按包内 `infer_cfg.yml` 和[官方预处理](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/deploy/python/preprocess.py)解码 RGB，线性缩放到高256、宽192，不保持宽高比；float32 乘1/255，减 mean `[0.485,0.456,0.406]`，除 std `[0.229,0.224,0.225]`，转换为 CHW。读取原 sigmoid 输出，不再次 sigmoid。[官方后处理](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/deploy/pipeline/pphuman/attr_infer.py)会强制选择某些类别；本评估不沿用这些展示字符串。

26项输出中，年龄19–21和性别22即时丢弃，不保存、不用于归因；保存其他22项可见字段的原始分数。标签没有通用衣服颜色。官方仓库[许可](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/LICENSE)为 Apache 2.0，本机许可文件 SHA-256 为 `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`；模型包未附单独许可文本。资产、配置、来源源码和许可指纹均随原始分数保存，许可文本保存在本机资产目录。

## 冻结对照与结果

复用现有 Real28 原归档和身份独立划分，4324张原裁剪按既有重复字节规则得到4319份：tune 2312、holdout 2007，各含50份参照。目标分母分别为2262和1957。图片序号不是时间；身份、镜头和换衣标注来自文件名。未重新划分素材、选择参照或调整 ReID 的0.94绝对门槛、0.13领先差值。

属性推理前保存协议指纹，先看 tune、后按相同协议检查 holdout，没有按属性效果搜索门槛。候选仅检查基线已接纳目标与该成员最高 ReID 分数的参照：袖长（ShortSleeve／LongSleeve）和下装（Trousers／Shorts／Skirt&Dress）各自最高分至少0.9、领先第二项至少0.3才作为数值上明确的类别；任一不满足为未知。两组类别都明确且都不一致时，仅把本次接纳改为未知，不宣称不同人。单属性、朝向、包帽变化不参与否决，不删错候选以提升次佳候选，不重算身份分数，也不把相关模型输出相乘。

holdout 结果如下；两种方案各行完全一致。三种镜头范围重复评价同一批目标，不能相加作为独立样本。

| 参照范围／目标 | 目标数 | 正确接纳 | 错误接纳 | 未知 |
| --- | ---: | ---: | ---: | ---: |
| 全镜头／同衣着 | 543 | 114 | 0 | 429 |
| 同镜头／同衣着 | 543 | 115 | 0 | 428 |
| 排除目标镜头／同衣着 | 543 | 2 | 0 | 541 |
| 全镜头／换衣 | 866 | 0 | 0 | 866 |
| 同镜头／换衣 | 866 | 0 | 0 | 866 |
| 排除目标镜头／换衣 | 866 | 0 | 0 | 866 |
| 全镜头／未登记 | 548 | 0 | 0 | 548 |
| 同镜头／未登记 | 548 | 0 | 0 | 548 |
| 排除目标镜头／未登记 | 548 | 0 | 0 | 548 |

tune 同衣着的全／同／跨镜头正确接纳分别为84／88／0，其余组均未知，两种方案也完全相同。零观察错误不代表家庭错认率已校准。独立复算 holdout 正确身份分数达到0.94的数量：全镜头同衣着121、同镜头119、跨镜头2，换衣均0。这是保留绝对门槛时的数学上界，不是属性模型成绩；本次原模型实测对照才支持无收益结论。

## 资源与适用边界

本机 Apple M4 Pro、macOS arm64，Python3.12.14、Paddle3.3.0、NumPy2.5.3、OpenCV4.13.0.92；原生CPU、Paddle数学线程和OpenCV线程各为1、batch1，固定 `enable_new_ir(False)` 执行包内 fluid 图。没有安装完整 PP-Human。[官方 macOS 安装说明](https://www.paddlepaddle.org.cn/documentation/docs/en/install/pip/macos-pip_en.html)提供 ARM64 CPU 支持。

各进程前三张为预热并排除于逐张分位统计：tune稳态2309份，holdout稳态2004份。tune／holdout 的预处理均值0.482／0.488ms，推理含输入输出复制均值10.239／10.222ms，含归档读取、指纹核对和JPEG解码的总均值10.800／10.786ms，总P95为10.996／10.981ms。推理循环墙钟25.014／21.687秒；运行库导入461.988／470.066ms，predictor创建47.628／48.882ms；创建耗时不含Python导入和归档校验。进程RSS（驻留内存）每20ms采样，峰值896.8／896.1MiB，包含Paddle与评估进程，不是模型增量占用，也不是峰值上界。官方V100 TensorRT FP16的0.54ms不能当成本机成绩。此资源观测不是长期线上并发预算。

仅从冻结的 tune 失败索引核对九张代表图，不按 holdout 挑例子。人体姿态变化时模型会给同一人的下装不同高分类别：`06_03_01_16` 的裙装分0.999，`06_03_01_8` 的短裤分0.995；前者朝后分0.936，但图中可见正面信息。`06_02_01_9` 下装短裤0.709／裙装0.849，`06_04_02_10` 袖长0.608／0.400，冻结规则保持未知。高分和类别领先也不能证明物理可见性或标签正确。

Real28没有独立姿态、遮挡、低光、裁剪完整度或属性真值，数值上明确的字段不等于这些专项已通过；遮挡／裁剪不完整的字段应未知，本次没有可推广的自动可见性判定。代表图的只读核对不能宣称背影、遮挡或低光集合通过。公开静态裁剪与有真实时间的视频独立处理，本次未产生人脸确认、TTL续期、支持窗口或家庭活动证据。原始分数、每项决策、协议、资源和代表图只在本机ignored data保存，入口见[离线评估说明](../../apps/backend/scripts/perception-evaluation/README.md#人体可见属性对照)。
