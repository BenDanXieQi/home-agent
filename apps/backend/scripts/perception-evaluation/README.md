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
