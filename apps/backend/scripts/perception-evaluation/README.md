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

绝对门槛与差值网格预设为 0 到 1、步长 0.01。在全部参照的调参集上选择“已登记身份正确接纳最多且已登记／未登记身份均无观察到的错误”的候选，同覆盖时优先较高差值再较高绝对门槛；无合格非空候选则返回 `null`。冻结候选后才报告留出集与各镜头／衣着分组，不根据留出结果改参数。这是探索性选择标准，样本内零错误不表示部署误归属风险已校准。报告中的 `scoreCandidate` 不能直接作为包含时间策略的 `appearanceCalibrationSchema`，命令不改变正式装配。

输出会原子替换指定目录中的同名报告：

- `manifest.json`：每份实际使用图片的原路径、SHA-256、尺寸、身份、镜头、衣着、划分及参照／目标角色；`results.json` 保存此文件的字节指纹。
- `duplicates.json`：重复字节对应的原图及被跳过路径。
- `observations.json`：各镜头方案下每份目标的正确身份最高分、错误身份最高分、正确身份与最强错误身份差值、最佳成员／领先差值及实际参照分数，无向量。
- `tune-grid.json`：所有预设候选在调参集的正确接纳、错误接纳、未登记身份接纳及未知数量。
- `results.json`：来源与许可指纹、模型／预处理／依赖、划分、候选、分数分布、同衣着／换衣／未登记身份分组及资源统计。正确覆盖率分母为已登记身份目标数，错误率分母为实际接纳数，未登记身份接纳率另列；零接纳时错误率为 `null`。RSS（进程驻留内存）仅逐图采样，包含离线特征和模型，不是线上缓存峰值。

固定素材包含 4319 份不同图片字节，5 份重复被跳过，100 份参照与 4219 份目标。调参候选 `threshold=0.94`、`margin=0.13` 在留出集全部参照下正确接纳 114／1409，548 份未登记目标全部未知，样本内错误接纳为零。同镜头同衣着为 115／543，跨镜头同衣着为 2／543，换衣为 0／866；高未知比例和很低的跨镜头覆盖不支持上线。这些是静态图的候选选择，未运行至少两份新帧支持规则。

Real28 图片都是 64×128 低清人体裁剪。模型训练数据未在本项目中明确，身份独立留出仅指本次调参未使用这些身份，不保证模型训练时未见。图片可能相邻且高度相关，每图比例不能解释为独立试验概率。衣着编号标明同人换衣，不提供不同人相似衣着的独立标签；也没有可靠原帧时间、同帧人脸／人体可用性或连续采样轨迹。因此不比较 1／5／10 分钟参照期限、500 毫秒支持跨度、支持窗口与推测期限，不报告在线闪断、形成延迟、缓存峰值或家庭误归属率。活动保存、纠正、终态、版本和页面联动的剩余验收继续见[成员短期外观归因计划](../../../../docs/plans/member-attribution.md#5-校准与验收)。

## 视频外观输入可用性

`analyze:appearance-video` 分别读取真实视频原帧，核对指定输入指纹，使用正式 `createDetector` 默认门槛 0.5、人体跟踪器、新特征资格过滤及 `createReid`。它是离线素材分析入口，不启动服务，不连接家庭数据库，不提供模拟身份或生命周期注入。每路顺序处理，不代表多路并发负载。

输入 JSON 保存 `sourcePage`、`attribution`、`license` 与 `videos` 数组。每个视频提供本机 `path`、真实下载 `url` 和 `sha256`。路径由运行者填入，不在共享文档保存个人绝对路径。最多八个视频；命令依赖本机 FFmpeg／FFprobe，默认分析前 302 秒，可通过 `--seconds` 指定不超过 3600 秒的范围。

```sh
bun run --cwd apps/backend analyze:appearance-video \
  --manifest ../../data/perception/member-attribution/meva-manifest.json \
  --output-dir ../../data/perception/member-attribution/meva-results \
  --seconds 302
```

[MEVA 官方下载说明](https://mevadata.org/resources/README-meva-kf1-data.html)提供公开 S3 数据，作者为 Kitware Inc. 与 IARPA，数据采用 [CC BY 4.0](https://mevadata.org/resources/MEVA-data-license.txt)。示例原始对象路径为 `drops-123-r13/2018-03-07/11/2018-03-07.11-00-00.11-05-01.admin.G329.r13.avi`；完整 URL 以 `https://mevadata-public-01.s3.amazonaws.com/` 为前缀。输入和报告应保留署名、许可与真实对象 URL，不把说明页面当作视频下载链接。

FFprobe 探测限于请求时段及 100 毫秒尾部余量，读取原始 PTS（解码后的呈现时间）；先核对尺寸符合正式原帧预算，再启动像素解码。探测和解码均固定选择第一条视频流；FFmpeg 关闭自动旋转，保留该流原始像素布局与尺寸。按平均帧率选择整数步长，使名义采样率不超过 3 fps；实际采样时间使用对应原帧 PTS，不用帧率重新生成时间。每份记录同时保存从 0 开始的原帧序号、原 PTS 与从首帧开始的相对时间。真正采样帧无 PTS 或时间倒退时失败；未采样的尾部 flush 帧可缺 PTS，报告单独计数，不伪造时间。FFmpeg 不插值或重复图片；输出帧数必须与选定原帧相符。

跟踪器只给本帧新提取、非预测、非缓存复用且通过现有重叠过滤的目标交付新外观证据。报告区分实际 ReID 调用次数、提取目标数、重叠过滤、缓存复用和预测目标。同帧有脸的定义仅为“检测器输出的人脸中心落在唯一实测人体框中”；不经过人脸质量检查、身份参考匹配、确认支持或异步接纳，所以不能称为人脸确认共同可用率。

`results.json` 在每路成功后原子更新，`source-N-frames.json` 保存该路逐帧计数、实测框、轨迹状态及新特征／人脸目标编号，不保存向量、像素或虚构成员标签。报告包含实际模型指纹、输入／输出契约、ReID 预处理版本、来源 manifest 字节指纹与以下指标：

- **新特征间隔**：同一本地轨迹两次合格新外观之间的实际媒体时间差；首份不产生间隔。不证明轨迹编号从未换人，也不把检测缺失视为分数失败。
- **有脸检测与新特征交集**：按目标观察计数，分别以全部合格新特征和有唯一对应人脸检测的目标为分母。一次目标出现多张脸也只计一次；没有对应分母时比例为 `null`。
- **资源**：逐帧采样的本进程 RSS、CPU、检测与跟踪耗时。顺序离线背压不模拟线上采样丢帧、计算名额、原帧过龄或身份结果迟到，不表示线上缓存峰值。

`confirmedFaceJointAvailability`、`inferenceFlashes`、`attributionLatencyMs` 保持 `null`：没有实际直接确认或正式归因输出时无法测量。没有全局身份映射、参考成员和已校准时间策略，不选择分数或比较参照 TTL；也不验收数据库、活动撤销或页面联动。MEVA 局部目标标注不能直接当家庭成员 ID 或跨镜头全局身份，连续视频文件也不能据文件名自动拼接成同人长间隔验收。
