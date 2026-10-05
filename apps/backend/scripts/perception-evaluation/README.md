# 感知离线对照评估

## 宠物检测与跟踪策略

该命令用同一组带人工框的本地素材，分别比较区域检测、低分框续接和跨帧确认。它直接复用当前固定检测模型、宠物跟踪器与几何关联规则，逐帧顺序执行；不需要摄像头、数据库或 Agent。

```sh
bun run --cwd apps/backend evaluate:pets \
  --data-dir ../../data/perception/pets \
  --output-dir ../../data/perception/optimization
```

输入根目录包含 `cat1/` 和 `dog/`，每个子目录包含：

- `manifest.json`：`source`、`samplingFps`、`frames`。每个采样帧提供从 1 开始的 `frame`、严格递增的 `timeMs` 和 JPEG 的 `sha256`。
- `groundtruth.txt`：按原视频帧排列，每行 `x,y,w,h`；非有限坐标或非正尺寸表示目标不可见。标注行必须存在。
- 八位补零的 JPEG 文件，例如 `00000001.jpg`。

图片指纹必须和 manifest 一致，解码尺寸受当前检测帧限额约束。命令不下载素材；输入帧不足以支持其他采样率时不补帧或声称测试了更高帧率。当前样本来源为 [VOT-LT2019](https://www.votchallenge.net/vot2019/dataset.html)，其他物体可能没有标注。

## 比较条件

每段素材评估 108 个组合：3 种区域方案乘以 36 种跟踪策略。

| 项目                     | 对照值                                           |
| ------------------------ | ------------------------------------------------ |
| 区域                     | 全景；全景＋中央正方形；全景＋沿长边两端的正方形 |
| 低分续接下限             | 0.5、0.1、0.2、0.3                               |
| 新轨迹最低分数           | 0.5、0.6、0.7                                    |
| 最近三次观察所需高分命中 | 1、2、3                                          |

区域只由画面尺寸计算，不使用人工框。全景保留；每个区域独立裁切并推理，结果回到原图坐标后按同类别 IoU 0.7 合并。IoU 是两个框的交集面积与并集面积之比。该方案用于测量固定区域的效果，并未实现运动区域提议或完整 SAHI 库。

检测器在评估中保留分数至少 0.1 的候选，按分数排序后执行当前同类抑制。跟踪器先关联分数至少 0.5 的框，再让未匹配的已确认轨迹关联低分框；低分框不能创建或确认轨迹。两轮都沿用同物种、IoU 至少 0.3、位置不确定性门控 9.4877，每轮最多 8 个候选，总共最多 8 条活跃轨迹。这是借鉴 [ByteTrack](https://github.com/FoundationVision/ByteTrack) 的两轮关联，不等同其完整实现或基准成绩。

跨帧确认采用最近三次跟踪输入的高分命中数。待确认轨迹连续两次未获高分关联后清理，所有轨迹仍按 2 秒实际失配时间过期。确认前的轨迹不进入输出。确认门槛思想参考 [Frigate 的分数过滤](https://docs.frigate.video/configuration/object_filters/)，本实验使用命中次数，不是其分数中位数算法。

线上 backend 使用检测下限 0.5、续接下限 0.5、新轨迹分数 0.5、首次命中即确认；校准参数目前由命令传给计算函数，不是 `config/perception.json` 支持的配置项。区域推理仅由评估命令调用。

## 输出与判读

`results.json` 保存环境、依赖版本、指标含义和全部对照结果；每段另保存 `*-results.json` 与 `*-candidates.json`。候选文件保存输入指纹、人工框、区域和原始检测结果，不保存像素。输出会替换同目录的同名评估文件；需要保留多次实验时使用不同输出目录。

- **匹配率**：标注可见帧中，至少一个同物种实测轨迹框与人工框的 IoU 达到 0.5 的比例。预测框不计作检出。
- **短期换号**：同一人工目标在两秒内再次匹配时编号变化的次数；必须和匹配率一起判断。
- **物种混淆**：异物种实测框与当前人工框重合的帧数。
- **未匹配框／目标不可见时的输出**：用于排查多余输出。单目标标注不覆盖其他物体，这些数量不能直接称为误报率或用来计算全场景精确率。
- **首次捕获延迟**：每次标注由不可见转为可见，到首次匹配的时间；同时报告未能捕获的可见区间数，不能只比较成功区间的平均延迟。
- **时效与资源**：墙钟耗时、CPU 时间和进程 RSS 采样峰值。前三帧不计入耗时统计，JPEG 解码不计入检测耗时；RSS 包含离线评估保存的候选及多组跟踪器，不代表线上单路占用。

时间前半段用于调参，后半段作为时间留出段复核，两段使用连续跟踪状态；后半段没有参与区域选择或模型计算。它仍是同一场景，不能替代独立摄像头、夜间或家庭遮挡素材的验证。全景推理在对照之间复用，组合的推理耗时是全景与对应额外区域耗时之和；108 个跟踪器的总 CPU 不是某个部署策略的 CPU。

本机逐次实验记录放在 Git 忽略的 `data/perception/`，当前文档只维护运行方式、策略与解释边界。改变默认策略前，应同时核对覆盖、物种混淆、换号、确认延迟和资源预算。

## 室内检测模型

`compare-indoor-models.ts` 在固定的已人工核对室内图片上比较 `det_4C`、YOLO11n、YOLO11s 和 YOLOX-Tiny。它仅评估原始检测，不对静态图片序列做跨图跟踪，也不调用区域裁切或摄像头服务。

```sh
bun run --cwd apps/backend evaluate:models \
  --model-dir ../../data/perception/model-comparison/models \
  --data-dir ../../data/perception/model-comparison/indoor \
  --output-dir ../../data/perception/model-comparison/indoor-results
```

模型目录提供 `yolo11n.onnx`、`yolo11s.onnx`、`yolox_tiny.onnx`；当前 `det_4C` 仍从项目固定资产读取。候选仅由离线适配器加载，不扩展正式检测池的模型路径接口。

- YOLO11 使用官方权重导出的静态 FP32 ONNX：640×640、batch 1、opset 17、无图内 NMS。预处理为居中补 114、RGB / 255，解析 `[1,84,8400]` 输出。导出说明见 [Ultralytics ONNX](https://docs.ultralytics.com/integrations/onnx/)。
- YOLOX-Tiny 使用[官方发布的 ONNX](https://github.com/Megvii-BaseDetection/YOLOX/releases/tag/0.1.1rc0)：416×416、左上对齐补 114、BGR 原始像素，解析 `[1,3549,85]` 输出并还原网格与步长；置信度为目标分数乘类别分数。依据[官方示例](https://github.com/Megvii-BaseDetection/YOLOX/blob/0.1.1rc0/demo/ONNXRuntime/onnx_inference.py)。
- 两种候选均映射 COCO 的 person/cat/dog 为当前 human/cat/dog；采用相同的同类 NMS IoU 0.7。候选没有当前模型的头部、人脸类别，结果不是完整能力替换证明。

数据目录含 `images/` 和 `manifest.json`。manifest 的 `source`、`annotationSha256`、`review` 记录来源与人工场景核对；`images` 中每项包含 `id`、十二位数字 JPEG 文件名 `file_name`、`sha256`、宽高、`group`、`split`（`tune` 或 `holdout`）、来源 URL，以及完整人猫狗框 `annotations`。框为 `className`、`bbox: [x,y,w,h]`、`iscrowd: 0`。图片指纹与尺寸须匹配，含目标 crowd 标注的图片应在入选前排除。

场景筛选必须在候选推理前固定，不得按某模型的成败挑图。仅有室内物体标签不代表室内场景，需要人工排除户外、场景不明或与评估定义不一致的图片。COCO 的验证图片不是独立家庭摄像头录像；此类对照只能作为模型筛选，不能代替固定机位、夜间、遮挡和连续身份的验收。

每个模型输出原图坐标的检测 JSON，以及汇总 `results.json`。评分按同类预测置信度从高到低，与尚未匹配的人工框做 IoU ≥ 0.5 的一对一匹配；重复框、错误类别与未匹配框计为 FP，未匹配人工框计为 FN。报告分别给出人、猫、狗的精确率、召回率、F1，以及无目标图片上出现预测的图片数。与单目标 VOT 的未匹配框统计含义不同。

固定比较阈值为 0.5，另比较 0.1/0.25/0.5/0.7；每个模型只根据 tune 子集的三类平均 F1 选择阈值，效果在 holdout 子集独立报告。各模型分数不一定同样校准，不能只比较一个阈值。时间使用同机单线程 CPU ONNX Runtime，包含预处理、推理和后处理，排除 JPEG 解码与三次预热；各模型按自身输入尺寸运行，报告的是整条模型配置的取舍，不是等输入分辨率的架构消融。

正式检测回归以 `tests/perception/fixtures/indoor-manifest.json` 固定的 63 张室内图片为主，运行入口和门槛见 [感知文档](../../../../docs/perception.md#针对性验证入口)。模型对照使用同一批图片时，应把该清单保存为数据目录的 `manifest.json`；户外运动素材仅用于补充检查跟踪行为。

## 音频链路与资源

`benchmark-audio.ts` 比较相同 PCMA 8 kHz 单声道输入、相同 16 kHz PCM 输出和固定 Silero 模型。输入按墙钟发送；前 5 秒预热，测量期间统计已观测父子进程的 CPU 累计下界、RSS、PCM 采样推进、媒体年龄、事件循环以及订阅开销。CPU 累计保留已退出进程的最后采样值，但最后采样到退出之间的工作可能少算。CPU 百分比以单个逻辑核为 100%；采样不足、有效性丢失或链路错误会使命令失败退出，不能把失败后的低资源占用当作优化结果。

```sh
bun run --cwd apps/backend benchmark:audio --variant=ffmpeg --sources=8 --seconds=30
bun run --cwd apps/backend benchmark:audio --variant=libav --sources=8 --seconds=30
bun run --cwd apps/backend benchmark:audio --variant=service --sources=8 --subscribers=16 --seconds=600
```

`ffmpeg` 使用正式独立解码器，`libav` 是仅供对照的进程内 `Demuxer → Decoder → FilterAPI` 链路，二者都执行同一个模型。`service` 使用正式音频服务、监督进程及 IPC；SSE 订阅中最后一路故意缓慢读取，用于核对隔离。命令同时报告外部 FFmpeg 与 node-av 内置 FFmpeg 版本；通过 `PERCEPTION_FFMPEG_PATH` 指定匹配版本可排除版本差异。不同版本的结果只代表具体部署组合，不能当作纯架构对照。对照按顺序运行，记录主机与其他负载；持续验证可与真实摄像头联合运行，但该结果属于竞争负载场景，不能与空闲主机数据混作同条件比较。RSS 包含基准进程及其子进程，不包括无关应用；合成输入不能证明真实摄像头的全部时钟与网络行为。

保留独立 FFmpeg 解码器的依据是单轨故障可独立回收，以及实际时效与 CPU 成本；进程内 libav 的内存优势不足以单独证明整体更优。对照实现不进入生产选择分支。

`verify-camera-audio.ts` 从正在运行的后端读取已提交设备清单，以工作室优先顺序验证所有摄像头；账号凭据仅从本机数据库读取。它以 `cpuRatio: 0.5` 和默认 3 fps 采样运行检测；视频 worker 从共同音视频预算中分配，实际峰值内存仍需观察。它启动独立 go2rtc 实例，使用本机 1986/18556 端口，提供临时浏览器页面、正式感知查询接口和资源观测，退出时释放自己拥有的播放、采集与进程。运行前保证这两个端口空闲；不替换日常使用的媒体服务。

```sh
bun --env-file=.env apps/backend/scripts/verify-camera-audio.ts \
  --binary=/path/to/verified/go2rtc --key=config/credentials.key \
  --management=http://127.0.0.1:3000 --seconds=600
```

浏览器需检查真实接收的音频采样和解码视频帧，不能只以 SDP 成功或连接状态作为通过依据。关闭、重新打开预览后，后台音轨运行应保持不变。运行时定期核对家庭作用域；发生变化时停止验证，避免沿用旧授权。该工具不会保存摄像头音视频。

原始测量放在 Git 忽略的 `data/perception/`；功能文档只维护可复现入口、设计取舍与已知验证边界。

## SenseVoice 持续语音链路

`../verify-speech.ts` 通过正式 `createAudioService`，或启用视频时通过正式 `createPerceptionService` 和感知 HTTP 路由验证语音。评估主进程只提供受控编码流、读取结果和观测资源；PCM 解码、单一 P3 VAD 与切段位于正式音频子进程，SenseVoice 位于该进程下的独立子进程。不使用另一套实验语音运行时。

先安装仓库依赖并按[语音模型资产](../../models/README.md#语音转写模型)放置固定权重；同一官方资产包中的 `test_wavs/zh.wav` 用作公开样本。评估复用正式服务的模型、VAD、切段和预算，不另安装运行库或装配第二套模型。将样本转为带静音间隔的 8 kHz 单声道 A-law 编码流，从仓库根目录运行：

```sh
mkdir -p data/perception/sensevoice
ffmpeg -v error -y \
  -i apps/backend/models/sensevoice/test_wavs/zh.wav \
  -af 'adelay=1000,apad=pad_dur=1.5' -ar 8000 -ac 1 -c:a pcm_alaw -f alaw \
  data/perception/sensevoice/continuous.alaw

ORT_DISABLE_TELEMETRY=1 bun apps/backend/scripts/verify-speech.ts \
  --audio data/perception/sensevoice/continuous.alaw \
  --output data/perception/sensevoice/production.json \
  --seconds 115 --sources 2 --video --lifecycle
```

`--audio` 只接受无文件头的 8 kHz 单声道 A-law 字节，最长 60 秒；按墙钟循环发送，每块 20 ms。`--seconds` 为 15–3600 秒，`--sources` 为 1–8 个物理音轨。`--dual-channel` 给每个物理设备配置两个镜头，总通道数仍不超过 8，用于核对共享音轨只有一次识别。所有场景使用正式 `speech` 配置，空闲卸载设为 5 秒以缩短验证；生产默认值仍为 60 秒。

- `--video` 提供 1280×720、15 fps 的移动图案 MPEG-TS 流，由正式视频子进程和其 FFmpeg 子进程读取、解码、采样及检测。配置请求 3 fps、`cpuRatio: 0.5`，不补帧。通过正式 HTTP 路由校验感知共享 schema 和结果输出。所有场景另实际请求 `/speech`，按语音收件箱共享 schema 校验响应。视频计数属于当前运行，来源重建后会重置，不是整个实验的累计帧数。
- `--lifecycle` 要求至少 110 秒及有语音的输入。第 12 秒暂停首路源端发送，第 17 秒恢复，核对正式断流重建；第 30 秒起等待识别开始且收件箱已有当前作用域片段后撤销来源，当场检查音轨与对应片段已清除，至少 5 秒后重新授权；第 50 秒起等待识别开始，确认进程的父 PID 和进程组属于音频进程后向其发送 SIGSTOP。第 72 秒切换为静音，核对模型进程退出；第 87 秒恢复人声，核对重新加载时音频 PID、运行身份和采样仍连续。只操纵本次创建的来源与进程。
- `--expect-silence` 从开始就发送静音，要求没有转写、ASR 加载次数为零；不能与生命周期场景一起使用。它只改变源端音频与验收预期，不绕过 VAD 或模型。

报告从正式交付调用逐段记录转写、接纳结果和拒绝，不靠每轨最近结果推导完整交付。通过条件要求每个物理来源至少交付一段、收件箱接纳／拒绝计数与实际调用一致、语音 HTTP 校验成功；静音场景要求没有交付。普通场景要求交接零拒绝；生命周期按片段实际所属的撤销运行，以及全部来源撤权到重新授权之间的独立窗口核对预期拒绝，窗口记录作用域、音轨运行和前后交接拒绝数，不能用任意容忍数量覆盖正常交接错误。故障后的恢复与新段交付仍须通过；故障注入造成的切段丢弃与取消记录在音频快照，不要求它们为零。

报告还记录 ASR 父进程／进程组关系、源端与识别故障、空闲释放、再次唤起、定期进程树 CPU/RSS，以及关闭后的自有子进程数量。JSONL 随运行写入，最终 JSON 汇总结果；重复执行覆盖指定输出。CPU 累计本次已观测进程的最后采样值，包含已退出进程；最后采样到退出之间的工作可能少算，因此是已观测累计下界。通过条件核对历次 CPU 累计不回退，不要求 RSS 单调。段尾时间来自音轨采样和 VAD，不是人工标注的真实说话结束时间。

输入是公开或自行构造的素材，不包含真实摄像头网络、远场、电视声或多人叠音。短时进程验证不能证明家庭转写准确率或日级内存稳定性。当前生产功能和限制见[本地语音转写](../../../../docs/perception.md#本地语音转写)。

## 人体外观离线校准

`calibrate:appearance` 用固定的 [Real28 官方数据](https://wanfb.github.io/dataset.html) 比较人物身份分数。作者提供 28 个身份、4 个镜头和不同日期换衣的 4324 张人体裁剪；[作者许可](https://wanfb.github.io/resources/licence.txt)为 Apache 2.0。仅在本机忽略的 `data/` 或临时目录保存素材、许可与报告，不将图片提交到仓库。PRCC 的官方条款仅限学术用途；Real28 可作为这里的公开统计输入，不表示家庭识别验收通过。

准备数据目录，放入作者 Google Drive 中的 `Real28.zip` 与官网许可文件 `LICENSE.txt`：

```sh
mkdir -p data/perception/member-attribution/real28
curl -L --fail \
  'https://drive.usercontent.google.com/download?id=1PQuhZJ05WBY62gdMMFiD8wBCItzKegWY&export=download&confirm=t' \
  -o data/perception/member-attribution/real28/Real28.zip
curl -L --fail 'https://wanfb.github.io/resources/licence.txt' \
  -o data/perception/member-attribution/real28/LICENSE.txt
bun run --cwd apps/backend calibrate:appearance \
  --data-dir ../../data/perception/member-attribution/real28 \
  --output-dir ../../data/perception/member-attribution/real28-results
```

命令要求本机 `unzip`，只接纳 SHA-256 为 `bb84e9dfed9e1a9801bfd7617e6addc44cee36d483d777b2db5d1308170d5de8` 的固定官方归档。读取已核对的归档字节，复制到独立临时目录后用原生工具解包；不使用调用方任意提供的解压图片。正常结束或失败会清理自有临时目录。该指纹固定本次下载内容，不是作者数字签名。

文件名 `identity_camera_clothing_index.jpeg` 按官方规则提供身份、镜头、衣着和图片序号，序号不是时间戳。官方 `gallery/query` 中都包含相同的 28 个身份，不能把这两个目录直接当独立调参／留出集。命令按 `sha256(real28-appearance-split:身份数字)` 排序：前 14 个身份为调参集，后 14 个为留出集；每集前 10 个提供参照，后 4 个完全不登记，用于观察未登记身份被误接纳的情况。划分在读取特征前固定。每个登记身份仅从衣着 1 的 gallery 图片选参照，先每镜头一份，再按镜头和序号补齐到最多五份。相同字节去重，重复标签矛盾时报错；参照优先，不让重复图片进入目标。

图片逐张解码成 RGB24，把整张已标注人体裁剪交给正式 `createReid`，使用固定模型指纹及正式 BGR、96×192、线性缩放、原始浮点输入与 L2 归一化。特征只保留在本次离线进程内，不导出向量，也不制造人脸确认或提交家庭活动。评分直接调用正式领域的 `appearanceScore`，每个候选身份取最多五份参照的最高分，再计算最佳与第二身份的差值。分别评估全部参照、只保留目标镜头参照、对所有候选排除目标镜头参照；后者才是这个固定方案的跨镜头成员选择。

绝对门槛与差值网格预设为 0 到 1、步长 0.01。在全部参照的调参集上选择“已登记身份正确接纳最多且已登记／未登记身份均无观察到的错误”的候选，同覆盖时优先较高差值再较高绝对门槛；无合格非空候选则返回 `null`。冻结候选后才报告留出集与各镜头／衣着分组，不根据留出结果改参数。这是探索性选择标准，样本内零错误不表示部署误归属风险已校准。报告中的 `scoreCandidate` 不能直接作为包含时间策略的 `appearanceCalibrationSchema`，命令不改变正式装配。`failure-index.json` 仅从 tune 的跨镜头错误最佳、正确但拒绝及换衣拒绝三类选择代表：按正确身份与最强错误身份分差、原文件名排序，取首／中／末索引。它保存原文件、指纹、分数及实际参照路径，不复制图片或向量到共享文档；holdout 不参与选例或参数修改。

输出会原子替换指定目录中的同名报告：

- `manifest.json`：每份实际使用图片的原路径、SHA-256、尺寸、身份、镜头、衣着、划分及参照／目标角色；`results.json` 保存此文件的字节指纹。
- `duplicates.json`：重复字节对应的原图及被跳过路径。
- `observations.json`：各镜头方案下每份目标的正确身份最高分、错误身份最高分、正确身份与最强错误身份差值、最佳成员／领先差值及实际参照分数，无向量。
- `tune-grid.json`：所有预设候选在调参集的正确接纳、错误接纳、未登记身份接纳及未知数量。
- `results.json`：来源与许可指纹、模型／预处理／依赖、划分、候选、分数分布、同衣着／换衣／未登记身份分组及资源统计。正确覆盖率分母为已登记身份目标数，错误率分母为实际接纳数，未登记身份接纳率另列；零接纳时错误率为 `null`。RSS（进程驻留内存）仅逐图采样，包含离线特征和模型，不是线上缓存峰值。

固定素材包含 4319 份不同图片字节，5 份重复被跳过，100 份参照与 4219 份目标。调参候选 `threshold=0.94`、`margin=0.13` 在留出集全部参照下正确接纳 114／1409，548 份未登记目标全部未知，样本内错误接纳为零。同镜头同衣着为 115／543，跨镜头同衣着为 2／543，换衣为 0／866；高未知比例和很低的跨镜头覆盖不支持上线。这些是静态图的候选选择，未运行至少两份新帧支持规则。

Real28 图片都是 64×128 低清人体裁剪。模型训练数据未在本项目中明确，身份独立留出仅指本次调参未使用这些身份，不保证模型训练时未见。图片可能相邻且高度相关，每图比例不能解释为独立试验概率。衣着编号标明同人换衣，不提供不同人相似衣着的独立标签；也没有可靠原帧时间、同帧人脸／人体可用性或连续采样轨迹。因此不比较 1／5／10 分钟参照期限、500 毫秒支持跨度、支持窗口与推测期限，不报告在线闪断、形成延迟、缓存峰值或家庭误归属率。活动保存、纠正、终态、版本和页面联动的剩余验收继续见[成员短期外观归因计划](../../../../docs/plans/member-attribution.md#5-校准与验收)。

## 视频外观输入可用性

`analyze:appearance-video` 分别读取真实视频原帧，核对指定输入指纹，使用正式 `createDetector` 默认门槛 0.5、人体跟踪器、新特征资格过滤及 `createReid`。它是离线素材分析入口，不启动服务，不连接家庭数据库，不提供模拟身份或生命周期注入。每路顺序处理，不代表多路并发负载。可用 `--identity-model-dir` 启用下述单参照身份阶段；解码、检测、跟踪和 ReID 仍共用同一管线，不启用该参数时不加载人脸模型。

输入 JSON 保存 `sourcePage`、`attribution`、`license` 与 `videos` 数组。每个视频提供本机 `path`、真实下载 `url` 和 `sha256`。路径由运行者填入，不在共享文档保存个人绝对路径。最多八个视频；命令依赖本机 FFmpeg／FFprobe，默认分析前 302 秒，可通过 `--seconds` 指定 0.000001–3600 秒的范围；请求时长按最接近的整数微秒传给 FFmpeg，报告另存实际 `decodedDurationUs`。

```sh
bun run --cwd apps/backend analyze:appearance-video \
  --manifest ../../data/perception/member-attribution/meva-manifest.json \
  --output-dir ../../data/perception/member-attribution/meva-results \
  --seconds 302
```

[MEVA 官方下载说明](https://mevadata.org/resources/README-meva-kf1-data.html)提供公开 S3 数据，作者为 Kitware Inc. 与 IARPA，数据采用 [CC BY 4.0](https://mevadata.org/resources/MEVA-data-license.txt)。示例原始对象路径为 `drops-123-r13/2018-03-07/11/2018-03-07.11-00-00.11-05-01.admin.G329.r13.avi`；完整 URL 以 `https://mevadata-public-01.s3.amazonaws.com/` 为前缀。输入和报告应保留署名、许可与真实对象 URL，不把说明页面当作视频下载链接。

FFprobe 探测限于请求时段及 100 毫秒尾部余量，读取原始 PTS（解码后的呈现时间）；先核对尺寸符合正式原帧预算，再启动像素解码。探测和解码均固定选择第一条视频流；FFmpeg 关闭自动旋转，保留该流原始像素布局与尺寸。按平均帧率选择整数步长，使名义采样率不超过 3 fps；实际采样时间使用对应原帧 PTS，不用帧率重新生成时间。每份记录同时保存从 0 开始的原帧序号、原 PTS 与从首帧开始的相对时间。按 FFprobe 的微秒时间精度先换算为整数再相减，采样区间为 `[0, decodedDurationUs)`，与 FFmpeg 的实际输出截止一致；恰在截止时刻的原帧不计入期待帧数。真正采样帧无 PTS 或时间倒退时失败；未采样的尾部 flush 帧可缺 PTS，报告单独计数，不伪造时间。FFmpeg 不插值或重复图片；输出帧数必须与选定原帧相符。

跟踪器只给本帧新提取、非预测、非缓存复用且通过现有重叠过滤的目标交付新外观证据。报告区分实际 ReID 调用次数、提取目标数、重叠过滤、缓存复用和预测目标。同帧有脸的定义仅为“检测器输出的人脸中心落在唯一实测人体框中”；不经过人脸质量检查、身份参考匹配、确认支持或异步接纳，所以不能称为人脸确认共同可用率。

`results.json` 在每路成功后原子更新，`source-N-frames.json` 保存该路逐帧计数、实测框、轨迹状态及新特征／人脸目标编号，不保存向量、像素或虚构成员标签。报告包含实际模型指纹、输入／输出契约、ReID 预处理版本、来源 manifest 字节指纹、入口执行源码 SHA-256 和媒体运行库版本，以及以下指标：

- **新特征间隔**：同一本地轨迹两次合格新外观之间的实际媒体时间差；首份不产生间隔。不证明轨迹编号从未换人，也不把检测缺失视为分数失败。
- **有脸检测与新特征交集**：按目标观察计数，分别以全部合格新特征和有唯一对应人脸检测的目标为分母。一次目标出现多张脸也只计一次；没有对应分母时比例为 `null`。
- **资源**：逐帧采样的本进程 RSS、CPU、检测与跟踪耗时。顺序离线背压不模拟线上采样丢帧、计算名额、原帧过龄或身份结果迟到，不表示线上缓存峰值。

未启用身份阶段时，`confirmedFaceJointAvailability` 为 `null`；启用后分别报告同帧合格新支持与新人体的数量，以及以新确认支持／目标新人体观察为分母的比例。`inferenceFlashes` 和 `attributionLatencyMs` 仍为 `null`，没有正式外观推测输出时不能测量。没有全局身份映射、参考成员和已校准时间策略，不选择分数或比较参照 TTL；也不验收数据库、活动撤销或页面联动。MEVA 局部目标标注不能直接当家庭成员 ID 或跨镜头全局身份，连续视频文件也不能据文件名自动拼接成同人长间隔验收。

视频解码输出 NUT（FFmpeg 的媒体容器格式）中的 RGB24 完整帧，复用正式 `readNutFrames`，由 libavformat（FFmpeg 的媒体容器读取库）提供帧边界与时间戳。采样后的时间从首帧归零，按 ffprobe 的原帧索引映射，并逐帧核对尺寸和相对时间。`execution` 记录启动时读取的入口源码指纹、外部 FFmpeg 的原生版本输出、FFprobe 的 [`-show_versions`](https://ffmpeg.org/ffprobe.html#Main-options) 结果及实际安装的 node-av 版本；node-av 的 [`getFFmpegInfo()`](https://github.com/seydx/node-av/blob/main/src/lib/utilities.ts) 提供进程内 FFmpeg 的构建配置和各库版本，包括读取 NUT 的 libavformat。元数据命令在分析前执行，超时为三秒，输出最多 64 KiB；取得失败时不继续分析，不用缺失版本生成可复现报告。入口指纹不包含全部导入源码，复现仍须保留对应仓库版本与依赖锁文件。

固定 MEVA 两个镜头的顺序离线分析分别交付 906／901 个 3 fps 原帧样本、102／9 次合格新特征；其中同帧有唯一对应人脸检测为 19／0 次。新特征间隔中位数均约 333 毫秒，95 分位分别约 667／333 毫秒。两路都没有缓存复用，不能证明静止复用时的覆盖或闪断；原视频没有全局身份映射，本地轨迹编号不能作为成员真值。

## ChokePoint 人脸与新外观联合输入

`analyze:chokepoint-identity` 读取 [ChokePoint 官方原始图片与人工眼坐标](https://arma.sourceforge.net/chokepoint/)，复用正式检测、人体跟踪、ReID、`prepareIdentityFrame`、YuNet／SFace 质量检查、`createIdentityAnalysis` 与家庭短期外观领域。它是隔离的公开素材校准入口，不连接摄像头、SSE、家庭数据库或活动保存服务，不改线上采样或匹配门槛。

素材仅限官方许可允许的非商业研究和个人实验，保留 NICTA 署名、Wong 等人的 CVPR Workshops 2011 论文引用（DOI `10.1109/CVPRW.2011.5981881`）和原许可。数据目录需要 `P1E_S1.tar.xz`、`groundtruth.tar.xz` 及从官方页面保存的 `official-page-with-license.html`；报告随附该原始许可页面，标明生成的实验统计不是原始图片／标注。下载由 [Zenodo 官方记录](https://zenodo.org/records/815657)提供，按作者要求逐个下载，不把素材提交到仓库。

固定原包 SHA-256 为 `3e310249afa86309175a13a04eb3e5cbea60f38e4018f9e4b8bd3fd80e39fcba`，人工标注包为 `2ba86bf1ebd3dbe14d170a8fede5d0911ab383feae1ab30ca2e779ae7671dc1d`。命令先复制两个包到自有临时目录，核对复制后字节，再从这些副本解包嵌套的三个镜头归档及 XML，拒绝指纹不一致的输入，不使用调用方已有的解压图片。正常结束、处理错误及模型初始化失败均清理自有目录。

现有模型安装入口可准备独立模型目录；分析只加载 YuNet／SFace 与已有 ReID，不加载宠物模型：

```sh
bun scripts/install-identity-models.ts data/perception/member-attribution/identity-models
bun run --cwd apps/backend analyze:chokepoint-identity \
  --data-dir ../../data/perception/member-attribution/chokepoint \
  --model-dir ../../data/perception/member-attribution/identity-models \
  --output-dir ../../data/perception/member-attribution/chokepoint-results
```

固定子集包含 `P1E_S1_C1/C2/C3`，每路 2292 张 800×600 原图；文件名帧号覆盖 0–4409，但大量图片缺失。只选原帧号能被 10 整除的图片，使用原帧号／官方 30 fps 计算相对时间，保留缺口，不以文件列表位置代替帧号，不拼成缩短的视频。每路 441 个名义采样槽中实际有 227 张原图，214 个槽缺少图片；缺失不算分数失败。

25 个主目标身份按 `sha256(chokepoint-face-split:身份数字)` 排序，前 13 个为 tune、后 12 个为 holdout，每组前 9 个预定登记，其余 4／3 个刻意不登记。该划分不是作者完整数据集的官方验证协议，只对本次分析的身份独立；模型训练数据未知。门槛、登记规则和排除规则均在看结果前固定，没有依据 holdout 改参。

登记规则为：在 C1 的原始 3 fps 图片中，为每个预定登记身份选第一份质量合格人脸。人体框来自真实检测；通过 `prepareIdentityFrame` 使用正式 848×480 几何转换；质量沿用 YuNet 分数 0.7、人脸短边至少 56 像素、清晰度至少 50，以及真实 SFace 特征。只有模型实际接受的人脸框包含标注的两只眼，才用该主目标 ID 给参照贴标签，每人一份。标签不写入轨迹状态。

目标阶段跨三个镜头排除该身份在登记帧及之前、以及登记后 30 帧内的图片，再排除登记原图字节与重复图片。排除窗口后才运行目标跟踪与身份采样；因此它是这个冻结协议下的剩余片段覆盖，不代表未经排除的完整视频吞吐。已登记／刻意未登记／登记不可用分别报告，不能将未登记目标保持未知解释为识别失败。

确认使用正式 `createIdentityAnalysis`：默认每轨迹间隔 1000 毫秒，至少三份新支持且跨度至少两个间隔；匹配沿用人脸绝对门槛 0.363、领先差值 0.08、30 秒证据期限。几何绑定由实际模型和跟踪结果完成，人工眼坐标仅用于登记候选标注和结果评价。标注只覆盖主目标；背景人体不继承主目标身份，没有真值的背景输出不进入错误率分母。

报告明确区分：

- **质量合格脸与新人体交集**：实际 `FaceModel` 样本与本帧 tracker 新特征回调相交，不等于确认。分别提供所有新人体观察、实际人脸采样目标两种分母，避免混淆未采样和质量拒绝。
- **新确认支持与新人体交集**：本帧合格脸必须被分析实际接纳，支持证据的序号确为本帧且标签属于当前 `confirmed`，再与同目标的新人体回调相交。裁剪去重拒绝、旧证据或沿用的确认不计；持续确认另列。
- **主体评价**：两只人工眼坐标必须落入唯一实测人体框；质量样本另核对实际人脸框。保存清晰度、裁剪指纹、接受序号、实际未知原因和支持数，不保存向量或图片。

为复用正式领域边界，适配器生成本次隔离运行的 UUID 作用域、运行与媒体代次，以及原帧号×3000 的绑定刻度。它们仅是校准进程自己的标识；原始数据没有网络 RTP 或绝对捕获时间，报告标明 `realRtp=false`、`absoluteCaptureTime=false`，不进入真实家庭输入。同步离线交付也不证明实时帧龄、异步迟到和计算资源接纳成立。

固定协议实际建立 18 份人脸参照。目标阶段 C1／C2／C3 分别有 136／156／196 张图片、94／87／73 次合格新人体观察、9／11／8 次质量合格脸，质量合格脸均与同帧新人体交付相交。21 次有主目标真值的合格脸中，已登记身份只有 2 次（均为 ID13，分别在 C1／C2，单次匹配正确），另外 19 次来自刻意未登记身份并保持未知。99 次可评价主目标观察中，已登记目标仅 9 次且全部在 tune，刻意未登记目标 90 次；holdout 的已登记目标分母为零，不能宣称完成已登记身份的独立留出验收。状态为 95 次未知和 4 次候选，没有真实 `confirmed`，新确认联合数和短期外观参照创建数均为零。零确认时确认错误率为 `null`，不能声称确认精度通过，也不能把全部合格脸当成已登记支持。

输出 `manifest.json` 保存实际读过的原图路径、指纹、原帧号及登记／目标阶段；`frames.json` 保存逐帧真值映射、真实模型质量与接纳摘要；`results.json` 保存输入与许可指纹、固定身份划分、独立人脸参照摘要、模型版本、各组分母、实际状态和外观领域诊断；`license-notice.html` 保留原许可页面。模型产生的私有人脸框仅供此入口核对主目标，正式身份 IPC schema 会去掉它。墙钟耗时和 CPU 统计覆盖登记／目标循环，不包含解包和模型启动；RSS 在登记前采样一次、随后仅在每个目标帧处理后采样，不代表登记过程或部署的峰值。

这个子集约 147 秒，没有换衣、真实家庭、5／10 分钟期限、数据库纠正或页面联动证据。没有确认时无法继续评价“确认后建立及使用参照”的覆盖；正式装配未注入外观策略，不输出外观推测，因此不产生外观推测活动；已有直接人脸／宠物活动保存不受影响。此离线入口不连接数据库。没有降低质量门槛、缩短确认间隔或延长期限来制造正例。

## 单参照近景视频的真实确认与参照形成

视频入口的 `--identity-model-dir` 模式固定使用前 5 秒登记、剩余片段做目标观察。在前缀中只选择第一份唯一质量合格人脸，由真实 `FaceModel` 和正式 `prepareIdentityFrame` 产生参照；同帧多个合格候选则不登记，前缀结束后不从目标补登记。目标像素与登记原帧相同则不接纳身份支持。登记与目标窗口固定，不能看结果后调整或用角色映射注入状态。

```sh
bun run --cwd apps/backend analyze:appearance-video \
  --manifest ../../data/perception/member-attribution/ami-manifest.json \
  --output-dir ../../data/perception/member-attribution/ami-results \
  --seconds 30 \
  --identity-model-dir ../../data/perception/member-attribution/identity-models
```

manifest 的每个视频可提供 `provenancePath` 与 `licensePath`：来源 JSON 的源 URL 和本地片段 SHA-256 必须与视频项相同，单份元数据不超过 256 KiB，读取前检查大小并限制实际读取字节数；可选路径与视频 `path` 均相对于命令的工作目录解析，省略时不读取或附带对应资料。来源信息随报告保留，许可通知另保存为 `source-N-license.txt`。来源 JSON 中的取得命令只作为资料保存，不执行。原帧像素及向量不写入报告。

已分析的 AMI 素材是官方 `ES2002a.Closeup1_orig.avi` 的源媒体 60–90 秒，720×576、25 fps，30 秒无损 FFV1 片段指纹为 `ab958a50d605b9a4c3859fc84ec8288d1e0911114319f5212fd229a1ea1fe23b`。[AMI 官方发布说明](https://groups.inf.ed.ac.uk/ami/download/)使用 CC BY 4.0；保留 AMI Project 署名、Carletta 2006 语料说明引用及许可。取得资料包含源 ETag、长度、修改日期、原生 FFmpeg 命令和源／本地 750 帧像素校验结果；分析入口另外核对本地文件指纹与实际解码／采样帧数。

原视频每九帧采一份，实际 2.778 fps，共 84 份：14 份登记窗口、70 份目标窗口。首帧产生唯一合格参照，没有按后续表现挑选登记图片。目标阶段真实接纳 24 份合格新脸；现有每轨迹 1000 毫秒间隔、三份支持且跨度至少 2000 毫秒的规则在片段 23.4 秒形成确认，对应源媒体 83.4 秒。确认输出 19 次，其中本帧新脸被实际接纳并支持当前确认的有 7 次；2 次与同帧新人体回调相交，比例为 2／7。目标窗口新人体观察为 32 次，联合比例为 2／32；另有 3 次新人体只沿用已有确认，14 次确认观察使用复用人体特征，均不作为新联合支持。

现有短期外观领域实际建立 2 份参照。最终报告的证据记录将它们精确绑定到新脸与新人体的原序号、局部 PTS 和轨迹；不以持续的 `confirmed` 标签代替本帧新支持。外观策略没有注入，`calibrated=false`、`inferred` 为空。这个正例证明单场景输入及建参照链路可运行，不选择 ReID 门槛、领先差值或时间策略，不产生外观推测活动。

AMI 的 Closeup1→MEE006／Agent A 映射只用于说明拍摄角色，不是所有检测人体的逐帧身份真值。结果中的确认表示“匹配唯一观察到的登记参照”，不宣称 MEE006 身份准确率、多人误归属率、跨镜头或独立成员留出验收。局部 PTS 加 60 得到源媒体秒，没有绝对开始时刻；隔离运行 UUID 和 90k 刻度只是本片的绑定，不是真实摄像头 RTP，也不进入家庭服务。

`detectAndTrackMs` 在身份阶段之前计时，只含原有检测／跟踪工作；墙钟和 CPU 循环统计包含可选身份处理，RSS 在身份模型加载后及逐帧处理后采样。这些不是端到端身份延迟或部署峰值。`analysisStatistics.confirmationDelayMsTotal` 的 18360 毫秒是目标阶段首次观察 5.04 秒到首次确认 23.4 秒的媒体跨度，不是 CPU 执行耗时。30 秒单人素材仍不能验证 1／5／10 分钟期限、实时过龄、异步迟到、数据库纠正或页面联动。

## 完整长视频的诊断时间策略对照

在完整官方 AMI 源上，视频入口可以使用 `--registration-start-seconds 60 --compare-appearance`：固定源媒体 60–65 秒寻找第一份唯一合格人脸，65 秒之后消费实际脸、人体与终态。此前 0–60 秒只保留原有检测／跟踪，不作为目标身份观察。源是完整的 `ES2002a.Closeup1_orig.avi`，352899072 字节、30759 帧、25 fps、1230.36 秒；SHA-256 为 `c7b3ec0402526990b9ce25146b83253d4521c6520656bcb5cf3ae2fc0322fb0a`。没有剪辑、拼接、复制帧或冻结参照。

```sh
bun run --cwd apps/backend analyze:appearance-video \
  --manifest ../../data/perception/member-attribution/ami-long/manifest.json \
  --output-dir ../../data/perception/member-attribution/ami-long-results \
  --seconds 1230.36 \
  --identity-model-dir ../../data/perception/member-attribution/identity-models \
  --registration-start-seconds 60 --compare-appearance
```

这个开关只在离线进程创建九个隔离领域实例：参照期限 1／5／10 分钟乘以支持窗口 1／3／5 秒。绝对分数 0.94、差值 0.13 沿用冻结 Real28 候选，推测期限固定 5 秒，至少两份不同新帧、跨度至少 500 毫秒、共同有效参照等规则保持现有实现。版本名称明确包含 `public-diagnostic`，从不传给 `main.ts`；正式装配仍不输出外观推测，因此不产生外观推测活动。

所有实例消费同一份实际模型输出；真实直接确认优先、参照更新、淘汰和自然到期照常运行。没有屏蔽脸、改动支持规则、冻结参照或人为创造身份空档；对照额外模型调用为零。源只有一个登记参照且缺逐帧身份真值，无法校准多人领先差值或把诊断推测计为正确身份覆盖。

完整输入采样 3418 帧，实际目标阶段 3237 帧。检测调用 3418 次，ReID 调用 1178 次，目标 FaceModel 调用 995 次；接纳 963 份合格新脸，其中 823 份属于当前确认的新支持，277 份与同帧新人体交付相交。缓存复用仍不作为新支持，也不延长期限。

固定对照结果如下，各支持窗口均未形成诊断推测：

| 参照期限 | 支持窗口   | 当前跟踪目标观察 | 合格尝试／完成／失败 | 失败原因                   | 无参照采样 | 参照累计创建 | 逻辑目标／临时样本／参照峰值 |
| -------- | ---------- | ---------------- | -------------------- | -------------------------- | ---------- | ------------ | ---------------------------- |
| 1 分钟   | 1／3／5 秒 | 3011             | 2／0／2              | 分数不足 1、直接确认恢复 1 | 52         | 164          | 2／137／5                    |
| 5 分钟   | 1 秒       | 3011             | 3／0／3              | 分数不足 1、支持窗口超时 2 | 3          | 63           | 2／49／5                     |
| 5 分钟   | 3／5 秒    | 3011             | 3／0／3              | 分数不足 1、直接确认恢复 2 | 3          | 63           | 2／49／5                     |
| 10 分钟  | 1 秒       | 3011             | 3／0／3              | 分数不足 1、支持窗口超时 2 | 3          | 38           | 2／26／5                     |
| 10 分钟  | 3／5 秒    | 3011             | 3／0／3              | 分数不足 1、直接确认恢复 2 | 3          | 38           | 2／26／5                     |

形成延迟仅从一次尝试的首份合格新支持到推测形成计算；完成后结束该尝试，失败按窗口超时、分数／冲突、直接确认或结束原因累计，最终尚未结束的尝试另列。本次全部失败、最终待定为零，形成延迟为无样本的 `null`，不能用零毫秒掩盖。仅统计当前 tracking 中未结束目标的观察分母，等待终态的目标只进入缓存计数。`reasons` 是这些目标的领域诊断原因，包含已直接确认目标的 `no_new_feature` 等状态，不是未知目标或身份失败的分布；`failedReasons` 才是已开始合格尝试的失败分类。推测丢失排除升级为直接确认及目标结束；未恢复丢失区间结束时累计分类，不会丢掉统计或跨直接确认阶段拼接成闪断。

本次没有推测形成，丢失／重获计数为零不表示闪断稳定性已通过。1 秒窗口在实际静止特征更新间隔中出现超时，不支持凭该素材选择它；1 分钟参照增加无参照与重复创建成本，没有提供可归属增量；5 与 10 分钟也没有观测到推测收益差异，不能据此选择家庭上线期限。九组全部缺少增量输出，拒绝将此诊断策略上线。未知不通过延长窗口、降低分数或增加模型调用来隐藏。

Real28 tune 的代表索引同时显示：同衣着跨镜头 81 份最佳身份错误、485 份最佳正确但拒绝，1186 份换衣样本拒绝。在冻结 0.94 绝对门槛下，holdout 跨镜头同衣着正确身份最高分达到门槛的只有 2／543，换衣为 0／866；即便只剔除错误成员，也无法挽救未过绝对门槛的目标。这只是现有分数的数学限制，未运行属性模型，不表示属性模型增益或准确率。

报告提供累计完成／失败／最终待定尝试、失败原因、推测出现／丢失／重获、媒体形成延迟汇总和每采样帧逻辑缓存峰值，逐帧记录保留政策版本及真实原帧索引。对照领域 CPU／墙钟另测，不是单个策略部署成本。进程资源测量若运行记录注明另一同素材进程短时重叠，不得作为无竞争部署基准；重复运行同一视频不视作独立验收。数据库与完整生命周期的28项操作验收仍由计划维护，没有新增故障注入或模拟验证入口。

## 人体可见属性对照

`person-attributes.py` 是独立的本机离线分析入口：固定 PP-LCNet 人体属性原权重、既有 Real28 manifest／参照／ReID 分数，先冻结协议，再按 tune → holdout 顺序运行原生 Paddle CPU。没有在线模块、家庭写入或模拟输入。采用判断和完整覆盖限制见[人体属性参考](../../../../docs/references/person-attributes.md)。

用临时目录隔离 Python3.12 环境和缓存，不修改项目依赖或全局 Python。准备官方模型包、官方来源源码与代码许可；`asset_dir` 为本机临时资产目录。Real28 原归档与已有基线报告的准备见上面的[人体外观离线校准](#人体外观离线校准)。

```sh
asset_dir=$(mktemp -d)
export UV_CACHE_DIR="$asset_dir/uv-cache"
uv venv --python 3.12 "$asset_dir/venv"
uv pip install --python "$asset_dir/venv/bin/python" \
  paddlepaddle==3.3.0 numpy==2.5.3 opencv-python-headless==4.13.0.92 \
  PyYAML==6.0.3 psutil==7.2.2
curl -L --fail \
  https://bj.bcebos.com/v1/paddledet/models/pipeline/PPLCNet_x1_0_person_attribute_945_infer.zip \
  -o "$asset_dir/model.zip"
unzip -q "$asset_dir/model.zip" -d "$asset_dir/model"
for file in deploy/pipeline/pphuman/attr_infer.py deploy/python/preprocess.py LICENSE; do
  curl -L --fail "https://raw.githubusercontent.com/PaddlePaddle/PaddleDetection/release/2.9/$file" \
    -o "$asset_dir/${file##*/}"
done
```

以下命令从仓库根目录执行。用新的输出目录冻结协议；freeze 将四份指定模型文件与固定官方归档成员逐一比较，并绑定归档、这些模型文件、`attr_infer.py`／`preprocess.py`／`LICENSE`、manifest、observations 和执行源码 SHA-256。infer 和 compare 使用相同的已核验指纹集合；目录中的额外说明、许可副本或其他源码不属于该资产绑定。重跑同一冻结协议时必须使用相同源码和输入；修改代码后用新的输出目录。源码快照可与协议指纹一起保留在 ignored data，不能修改旧快照后沿用原指纹。

```sh
attribute_script=apps/backend/scripts/perception-evaluation/person-attributes.py
baseline_dir=data/perception/member-attribution/real28-failure-results
output_dir=data/perception/member-attribution/real28-attributes-native
"$asset_dir/venv/bin/python" "$attribute_script" freeze \
  --baseline "$baseline_dir" --output "$output_dir" \
  --archive data/perception/member-attribution/real28/Real28.zip \
  --model "$asset_dir/model/PPLCNet_x1_0_person_attribute_945_infer" \
  --model-archive "$asset_dir/model.zip" --sources "$asset_dir"
cp "$attribute_script" "$output_dir/executed-script.py"
for split in tune holdout; do
  "$asset_dir/venv/bin/python" "$attribute_script" infer --split "$split" \
    --baseline "$baseline_dir" --output "$output_dir" \
    --archive data/perception/member-attribution/real28/Real28.zip \
    --model "$asset_dir/model/PPLCNet_x1_0_person_attribute_945_infer" \
    --model-archive "$asset_dir/model.zip" --sources "$asset_dir"
  "$asset_dir/venv/bin/python" "$attribute_script" compare --split "$split" \
    --baseline "$baseline_dir" --output "$output_dir"
done
```

协议仅对 ReID 已接纳目标检查最高分参照；袖长（ShortSleeve／LongSleeve，输出索引 2／3）和下装（Trousers／Shorts／Skirt&Dress，输出索引 11／12／13）都明确且不一致才退回未知，单属性、朝向和包帽均不否决身份。不删除错候选以提升次佳候选，也不重算或相乘身份分数。类别明确要求最高分至少0.9、领先至少0.3；低分或接近则未知。它不提供自动遮挡／完整度判定，高分不能当作可见性保证。绝对门槛0.94、领先差值0.13和划分不再搜索；属性一致不抬高身份分数。年龄和性别输出即时丢弃，保存22项可见属性原分数，不保存人体向量或图片。

输出 `protocol.json`、`tune-raw.json`、`holdout-raw.json` 和各自 `*-comparison.json`。raw 包含每张裁剪 SHA、实际标签索引、资产／源码指纹、环境和资源；compare 核对这些冻结绑定及完整 split 后保存逐项接纳与参照，不允许混合另一份模型或基线报告。4324张原图按既有5份字节重复清单得到4319份输入，不把重复图再计为独立目标。

前三张预热，稳态分母为实际样本数减3。逐张总耗时包括归档读取、裁剪指纹、JPEG解码、预处理和推理复制；各阶段另分列。`importMs` 计运行库导入，`loadMs` 计 predictor 创建，均不计入逐张稳态。Paddle数学线程配置请求为1；入口在创建 predictor 前调用 `cv2.setNumThreads(1)`，raw 的 `opencvThreads` 保存推理结束时 `cv2.getNumThreads()` 的实际观测值。运行库可改变OpenCV设置，不能把创建前的请求值当作全流程单线程保证；当前没有逐阶段线程数观测。RSS每20ms采样，包含运行库、模型和整个评估进程，峰值是采样观测值，不是模型净增量或线上并发预算。素材没有时间戳，不做跨静态图TTL／支持窗口；没有属性、遮挡、姿态和低光独立真值，不宣称这些专项通过。

### 固定 Real28 对照结果

复用现有 Real28 原归档和身份独立划分，4324张原裁剪按既有重复字节规则得到4319份：tune 2312、holdout 2007，各含50份参照。目标分母分别为2262和1957。图片序号不是时间；身份、镜头和换衣标注来自文件名。未重新划分素材、选择参照或调整 ReID 的0.94绝对门槛、0.13领先差值。

holdout 结果如下；两种方案各行完全一致。三种镜头范围重复评价同一批目标，不能相加作为独立样本。

| 参照范围／目标       | 目标数 | 正确接纳 | 错误接纳 | 未知 |
| -------------------- | -----: | -------: | -------: | ---: |
| 全镜头／同衣着       |    543 |      114 |        0 |  429 |
| 同镜头／同衣着       |    543 |      115 |        0 |  428 |
| 排除目标镜头／同衣着 |    543 |        2 |        0 |  541 |
| 全镜头／换衣         |    866 |        0 |        0 |  866 |
| 同镜头／换衣         |    866 |        0 |        0 |  866 |
| 排除目标镜头／换衣   |    866 |        0 |        0 |  866 |
| 全镜头／未登记       |    548 |        0 |        0 |  548 |
| 同镜头／未登记       |    548 |        0 |        0 |  548 |
| 排除目标镜头／未登记 |    548 |        0 |        0 |  548 |

tune 同衣着的全／同／跨镜头正确接纳分别为84／88／0，其余组均未知，两种方案也完全相同。零观察错误不代表家庭错认率已校准。独立复算 holdout 正确身份分数达到0.94的数量：全镜头同衣着121、同镜头119、跨镜头2，换衣均0。这是保留绝对门槛时的数学上界，不是属性模型成绩；本次原模型实测对照才支持无收益结论。

### 本机资源与适用边界

本机 Apple M4 Pro、macOS arm64，Python3.12.14、Paddle3.3.0、NumPy2.5.3、OpenCV4.13.0.92；原生CPU、batch1，Paddle数学线程配置请求为1；入口在创建 predictor 前请求OpenCV线程为1，但创建后运行库改变了该设置，两个进程推理结束时 `cv2.getNumThreads()` 均为14。这些耗时不代表OpenCV全流程单线程成绩，也没有逐阶段线程数观测。固定 `enable_new_ir(False)` 执行包内 fluid 图。没有安装完整 PP-Human。[官方 macOS 安装说明](https://www.paddlepaddle.org.cn/documentation/docs/en/install/pip/macos-pip_en.html)提供 ARM64 CPU 支持。

各进程前三张为预热并排除于逐张分位统计：tune稳态2309份，holdout稳态2004份。tune／holdout 的预处理均值0.482／0.488ms，推理含输入输出复制均值10.239／10.222ms，含归档读取、指纹核对和JPEG解码的总均值10.800／10.786ms，总P95为10.996／10.981ms。推理循环墙钟25.014／21.687秒；运行库导入461.988／470.066ms，predictor创建47.628／48.882ms；创建耗时不含Python导入和归档校验。进程RSS（驻留内存）每20ms采样，峰值896.8／896.1MiB，包含Paddle与评估进程，不是模型增量占用，也不是峰值上界。官方V100 TensorRT FP16的0.54ms不能当成本机成绩。此资源观测不是长期线上并发预算。

仅从冻结的 tune 失败索引核对九张代表图，不按 holdout 挑例子。人体姿态变化时模型会给同一人的下装不同高分类别：`06_03_01_16` 的裙装分0.999，`06_03_01_8` 的短裤分0.995；前者朝后分0.936，但图中可见正面信息。`06_02_01_9` 下装短裤0.709／裙装0.849，`06_04_02_10` 袖长0.608／0.400，冻结规则保持未知。高分和类别领先也不能证明物理可见性或标签正确。

Real28没有独立姿态、遮挡、低光、裁剪完整度或属性真值，数值上明确的字段不等于这些专项已通过；遮挡／裁剪不完整的字段应未知，本次没有可推广的自动可见性判定。代表图的只读核对不能宣称背影、遮挡或低光集合通过。公开静态裁剪与有真实时间的视频独立处理，本次未产生人脸确认、TTL续期、支持窗口或家庭活动证据。原始分数、每项决策、协议、资源和代表图只在本机ignored data保存，官方能力与执行契约见[人体可见属性参考](../../../../docs/references/person-attributes.md)。
