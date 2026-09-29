# 本地目标检测与人宠跟踪

本地检测模块使用 Bun 管理的独立计算子进程、Piscina 线程池和 ONNX Runtime CPU 执行 `det_4C.onnx`，接受图片文件任务或 RGB24（每像素三个 8 位红、绿、蓝通道）帧，返回人体、猫、狗、头部和人脸检测框。检测所需的文件读取、哈希、解码、缩放和推理在计算子进程中执行。检测池返回结果，不写输出图片；可选标注由独立图片命令在自己的进程中生成和保存。检测结果是画面证据，不表示房间在场或人员身份。

## 安装与使用

在仓库根目录运行 `bun install`。目标检测固定使用项目内随附的 `apps/backend/models/det_4C.onnx`，来源与原许可保存在同目录的 [README.md](../apps/backend/models/README.md) 和 [LICENSE.md](../apps/backend/models/LICENSE.md)。运行时不下载模型。

模型路径由感知模块内部常量统一定义，按模块位置解析，源码运行与构建产物使用同一份项目资产，不受启动工作目录影响。计算池、图片命令、基准命令和真实模型测试共用该常量，不接受模型路径参数或环境变量覆盖；调用方只提供待检测输入及处理选项。构建检查模型与许可证文件存在；部署时一起携带 backend 的 `models/` 和 `dist/`，保持同级布局。缺失模型时初始化明确失败。

`patches/piscina@5.3.2.patch` 修正 Piscina 的 `TransferList` 类型声明：从 Node 的 `StructuredSerializeOptions.transfer` 推导数组类型，避免从 `MessagePort.postMessage` 的重载错误推导成选项对象。Bun 安装时通过 `patchedDependencies` 自动应用；补丁不改运行时 JavaScript，使直接传入 `transferList` 能通过类型检查，无需类型断言。升级 Piscina 时需核对声明并移除已被正式版本覆盖的补丁。[Bun 补丁机制](https://bun.com/docs/pm/cli/patch)

```sh
bun run --cwd apps/backend detect:image --output-dir ../../data/perception /path/to/image.jpg
```

可传入多张图片；同一个模型 session 顺序处理，最后释放 session 并关闭计算池。`--output-dir` 可省略；指定时保存带框 PNG。标准输出为 JSON Lines（每行一个 JSON 对象）：首行为模型路径、SHA-256、输入输出元信息、运行环境、依赖版本及资源预算，其后每行是 `image_detected` 结果，包含 `imagePath`、`inputSha256`、尺寸、检测框、分段耗时及可选的 `annotatedImage` 路径。图片按存储像素方向解码，不应用 EXIF 旋转。模型指纹在子进程初始化时计算；检测输入在子进程有界读取一次，用同一份字节计算哈希并解码。指定标注导出时，命令重新有界读取图片并核对哈希，确认与检测时的内容一致后再画框；原图已变更则拒绝导出。运行期间不修改模型和输入图片。

```sh
bun run --cwd apps/backend build:perception
ORT_DISABLE_TELEMETRY=1 bun apps/backend/dist/detect-image.js /path/to/image.jpg
```

backend 的 `build` 同时构建计算子进程入口与图片命令，并生成 source map（将构建后的报错位置映射回源码）。图片命令不要求数据库、摄像头、go2rtc 或 LLM。后台摄像头持续检测使用下述独立配置与 HTTP 接口；页面不是采集的所有者。当前未新增感知展示页面。

## 摄像头持续检测

当前摄像头检测仅调用本地 ONNX 模型，不向 LLM 发送帧或视频，也不产生 LLM token 用量。音视频前置筛选和语义模型调用尚未接入，后续边界见[摄像头感知与推理接入计划](plans/media-perception.md)。

当前检测不依赖 Agent 进程、模型凭据或 checkpoint 数据库。Agent 服务不可达不影响检测启停与查询；仍需满足摄像头授权、backend 数据库、go2rtc、FFmpeg 与检测模型等实际依赖。单独运行见[本地运行](running.md#单独启动与检查)。现有查询/订阅提供检测、人体及猫狗跟踪观测与健康信息，不提供片段窗口、候选媒体或 Agent 判断。

启动前在 backend 宿主安装 FFmpeg（macOS 可用 `brew install ffmpeg`，Linux 使用系统软件包）；`PERCEPTION_FFMPEG_PATH` 默认 `ffmpeg`，可指定宿主可执行文件。只在 go2rtc 容器安装 FFmpeg 不满足此要求。`bun run setup` 将禁用示例复制为 Git 忽略的 `config/perception.json`，不覆盖已有配置。缺文件或 `sources: []` 表示禁用，不自动打开全部摄像头。

```json
{
  "cpuRatio": 0.5,
  "sources": [{ "deviceId": "替换为当前家庭设备标识", "channel": 1 }],
  "sampleFps": 3,
  "firstFrameTimeoutMs": 90000,
  "silenceTimeoutMs": 30000,
  "maxFrameAgeMs": 2000
}
```

`cpuRatio` 范围为 `(0, 1]`，默认 `0.5`。backend 进程启动时通过 `availableParallelism()` 读取宿主可用逻辑 CPU 数，启用检测池时计算 `max(1, floor(可用核数 × cpuRatio))` 个 worker。预算在本次进程运行内固定，初始化失败重试、计算恢复和摄像头增减都不重新定容；修改比例后重启。图片命令使用同一默认比例，程序调用 `createDetectionPool({ cpuRatio })` 可指定比例。健康接口 `compute.budget` 显示实际核数、比例和 worker 数；报告同时记录实际预算。该比例限制推理并发，不是整个项目的 CPU 硬配额，也不是内存配额；FFmpeg、backend 与每个独立模型会话仍会占用资源。

设置 `"sources": "household"` 可明确启用当前家庭全部有资格的摄像头通道。来源集合来自已提交的设备清单，并随家庭变更、设备增减、通道变化和撤权同步；移除时先撤销结果资格再清理执行资源。新增、移除和暂时断流均不重建计算池。显式设备列表只分析列出的通道。两种模式都受 8 路解码上限约束；家庭来源超过上限时报告不可用并停止分析，不静默截断设备清单。默认示例仍为禁用状态。

设备标识必须是实际米家数字标识，通道为 1 或 2；只接纳当前家庭已提交设备清单中有访问资格的摄像头通道。配置最多 64 KiB、8 路，不允许重复设备/通道或未知字段。每路采样默认上限 3 fps（每秒帧数），首张完整帧等待 90 秒，之后 30 秒无完整帧报告媒体故障；最大帧龄默认 2 秒。断流等待须大于采样间隔，低采样率需要同时调大等待。配置和 FFmpeg 路径修改后重启 backend。无效配置、FFmpeg 缺失或模型初始化失败只使感知不可用，家庭设备清单和预览继续运行。

采集独立于浏览器。米家适配器授予当前内部分析读取描述；计算子进程向 go2rtc 私有 `POST analysis` 发送已有 session/source 关联，通过 MPEG-TS（视频传输封装）读取 H264/H265 编码的视频。请求、来源、内部通道或 session 结束会关闭消费者，不增加分析 ID、DELETE 或心跳。物理摄像头连接和断流恢复仍由现有媒体模块管理；计算失败只恢复计算，不重连物理摄像头。

FFmpeg 在计算子进程下运行，单路独立解码，关闭音频与字幕、保留源尺寸，按解码时间戳通过 `select` 选择真实输入帧，再转换颜色并输出 PPM（带尺寸头的无压缩图像格式）封装的 RGB24 帧；拼帧器去掉 PPM 头，交付完整像素。宽高和总像素使用 P0 限额，超限明确失败。被跳过的输入帧不转换为 RGB、不进入管道和 Bun 像素缓冲区；时间戳回退后重新开始选择，时间戳仅用于采样，不充当可信拍摄时间。帧序号按采样后的完整 RGB 帧递增，静止画面照常采样；接收节奏达不到采样上限时不复制帧。`receivedAt` / `sampledAt` 是本机完整 RGB 帧可用及接纳该采样帧的 Unix 毫秒时间戳，`mediaTime: null` 表示没有可信媒体拍摄时间；不能把帧龄当作物理拍摄延迟。检测框基于返回尺寸的 `decoded_rgb24` 像素坐标，保持源尺寸，无额外缩放坐标映射。

### 状态与资源所有权

- `mijia/perception-source.ts` 从已提交家庭状态判断资格；`perception/service.ts` 持有启用意图，协调运行授予、撤销、读取重试与计算重试。家庭作用域、媒体 revision、来源或计算代变化时先撤销结果资格，再清理资源。
- `observation-store.ts` 独占已授予运行、最新观测与公开健康，使用 `observations.ts` 的纯规则接纳结果。运行、任务序号或帧龄不符的结果不得替换当前证据；没有新帧也按期限过期。没有数据、有效空检测、过期和不可用分别表达。
- 子进程 `video/runtime.ts` 持有本代来源集合；每路 `video/source.ts` 的 XState actor（状态机运行实例）拥有生命周期、序号与在途关联，独占最新帧槽。`ffmpeg-decoder.ts` 独占 FFmpeg、管道和半帧拼装，`scheduler.ts` 只保存就绪顺序，不复制像素。`video/events.ts` 定义应用执行事件，供观测接纳和 IPC 校验共同使用；视频运行模块接收读取闭包与检测能力，不依赖厂商访问描述或计算通信协议。XState 上下文赋值与帧槽、统计和唤醒动作分开。计算空闲或新来源就绪时触发轮转，忙时不轮询，也不为追新中断原生推理。
- 每路最多一张待处理完整帧、一个在途检测；新帧替换待处理帧。解码器另保留至多一张正在组装的帧及 128 字节头。管道使用背压；go2rtc 每个分析请求最多排队 32 个媒体块或 4 MiB，超限结束该消费者；写入最多等待 5 秒。每通道最多 4 个分析消费者。FFmpeg 单解码/编码线程和单滤镜线程，限制输入探测至 1 MiB、1 秒，单次分配 32 MiB、输入像素上限与 P0 一致；这些不是整个进程 RSS（驻留物理内存）硬限额。
- 视频 RGB 留在计算子进程，提交时把缓冲区所有权转移给本次任务选中的推理 worker。主进程只监督控制、结果和每次视频任务硬期限，沿用 P0 的初始化、任务、恢复及关闭预算。计算进程使用独立 POSIX 进程组，FFmpeg 继承该组；强制终止后确认组内没有存活进程，未确认时不重建。正常停止先取消分析读取、等待解码器退出，再排空计算并关闭模型。

### 查询、订阅与指标

| 接口                         | 行为                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/perception`        | 服务/计算状态、运行配置、模型哈希与提供方、逐路健康及最新观测                  |
| `GET /api/perception/stream` | `snapshot` 当前完整视图及 15 秒心跳；重连取得当前状态，无历史回放              |
| `POST /api/perception/retry` | 合并并发重试；已有池调用其重试，初始化失败未取得池时重新创建；配置无效仍需重启 |

服务顶层状态与计算池一致：就绪时为 `running`，自动重建时为 `recovering`，恢复预算耗尽时为 `unavailable` 并保留错误，显式重试成功后恢复运行。

接口沿用本地管理访问限制和 `no-store`。公开响应不包含分析端点、内部 session/source ID 或凭据。SSE（服务器推送事件流）最多 16 个连接，每连接只等待一个当前更新、单次快照最多 2 MiB、写入最长 15 秒；慢连接关闭，不反压检测。HEAD 不创建订阅。

`complete = sampled`（采样后交付的完整 RGB 帧）；`sampled = submitted + replaced + expired + discarded + pending`；`submitted = succeeded + failed + inFlight`。FFmpeg 内丢弃的帧不经过应用，当前不报告源帧总数或采样丢弃数，不把缺失统计写成零。`succeeded` 是模型完成，`published` 是主进程接纳发布；过期结果和其他拒收分别计数。计算异常退出时，最后收到的执行计数是已知快照，仍在途的任务不可解释成成功或无人。逐路计数按来源运行，不跨撤销或重建累加；顶层 `rejectedRetiredResults` 单独累计失效运行的迟到完成，不改写新运行的状态或计数。

逐路报告采样后完整帧数量、替换、丢弃、过期、计算成功/失败、在途和待处理数量、有效发布、拒收、最长调度等待、最长有效观测间隔、首次发布等待及等待首个结果的时长。帧龄 P50/P95 使用最近 512 个已完成或提交前过期样本，最大值覆盖本次来源运行；`ageSamples` 和 `elapsedMs` 说明样本规模和运行时长。`ageMs` 是发布时帧龄，`validity` 随当前时刻变化。子进程报告本地单调时钟测得的持续时间，主进程用同宿主接收时间补计 IPC（进程间通信）停留，时钟倒退的结果拒收；接纳后的过期计时用主进程单调时钟。

### 完成状态与验证范围

P1 摄像头持续检测已完成，已通过当前 macOS arm64 双摄范围的功能、故障恢复及短时运行验收。

macOS arm64 已通过正式后台入口读取真实双摄并持续检测，源码和构建入口共享相同资源布局。针对 P1 的检查覆盖任意分块拼帧、最新帧所有权、轮转调度、过期通知、旧运行/乱序拒收、合成 H264/H265 媒体、单路断流恢复、持续过载、反复启停、SSE 连接上限、推理硬期限后的整组回收，以及初始化失败与显式重试。真实双摄另已核对解码器单路终止后恢复、计算任务超时后重建、慢订阅及预览共存。合成媒体故障不代表已覆盖所有真实设备和固件故障。

长期运行、其他平台和更大规模负载属于尚未覆盖的部署验证范围，不作为 P1 未完成项。原始验收记录放在 Git 忽略的 `data/perception/`。当前不提供音频分析、语义推理、人或宠物个体身份、历史回放或媒体保存。

## 人宠跟踪与人体外观特征

当前返回的是来源内的局部观察，不提供成员身份、房间定位或最后出现房间。人宠最后出现记录归家庭领域，尚待媒体证据与身份核验接入；跟踪可辅助选帧及减少重复核验，不是独立画面识别的必要条件。设计见[人宠出现记录](plans/household-model.md#人宠出现记录与最后出现房间)。

摄像头检测完成后先发布基础观测，再独立执行 P2。每个来源运行独占人体、猫狗轨迹及人体外观历史，头部和人脸只作为检测框输出。人、猫、狗共用该运行的唯一编号分配器，每条轨迹通过 `className` 区分 `human / cat / dog`。轨迹由 `runId + trackId` 标识；运行替换后不能沿用，外观相似性也不等于人物身份。图片检测命令不创建轨迹。

DeepSORT 使用位置和速度的卡尔曼滤波（根据实测框与运动状态预测下一位置）、外观余弦距离与位置不确定性门控进行关联；按最近实测时间分组匹配，组内求全局最小代价，再用交并比关联上一轮仍实测的未匹配轨迹。速度以像素/秒表示，初始速度标准差取人体高度的一半；预测协方差按实际秒数积分位置与加速度噪声，避免直接照搬逐帧速度尺度。预测按两次输入的实际单调时间差推进，失配超过 2 秒即删除，过期后的重入使用新编号；丢帧不按固定帧率补算。来源断流或撤销只表示结果不可用，不生成“人已离开”的判断。

默认人体确认阈值为 0.5，`n_init=1`（第一次有效检测即建轨迹），外观距离上限 0.2，位置门控阈值 9.4877，IoU 距离上限 0.7。每路最多 8 条活跃人体轨迹，最多处理置信度最高的 8 个人体，每条保存最近 50 个归一化特征。容量不足时 `omittedHumans` 表示本次未形成实测轨迹的人体数，不影响基础检测框。

`fast` 模式仅在最近两次实测中心位移同时小于框对角线的 5% 和 10 像素、当前预匹配无歧义时复用原特征；发生交叠歧义时重新提取。`human_reid_skip_windows=4` 按跟踪更新次数计数，距最近一次提取达到 4 次就刷新，不是 P4 音视频窗口数；复用不增加特征历史，也不更新特征提取时间。

### 猫狗连续跟踪

猫、狗默认随摄像头检测进入位置跟踪，无需额外配置。复用原检测框和基于实际时间的卡尔曼预测，按同物种预测框的交并比进行全局匹配，并以位置不确定性门控排除不合理跳变。确认阈值为 0.5，IoU 至少 0.3，位置门控上限 9.4877；猫和狗始终不能互相继承编号。短暂漏检时输出预测状态，2 秒内只有符合位置匹配条件才续接，超过期限重新出现会分配新编号。

猫狗合计最多 8 条活跃轨迹，与 8 条人体轨迹分开限额，单路输出最多 16 条。`omittedPets` 统计本次未形成实测轨迹的猫狗检测数。帧尺寸变化清空轨迹状态，继续递增编号；停止或替换来源运行会清理全部轨迹。跨摄像头或跨运行不关联编号。

宠物不使用人体 ReID 模型，也不保存外观向量；其 `feature=not_applicable`、`featureAt=null`。纯宠物画面不会启动 ReID 进程或预留外观计算并发，只增加有界的位置关联计算，复用现有跟踪帧分支。人宠混合画面中，仅人体裁切送入 ReID。相似宠物密集交叉、完全遮挡、快速运动或检测类别抖动仍可能断轨或换号，轨迹编号不能当作宠物身份。

宠物专项测试覆盖同类交叉的运动关联、猫狗隔离、短暂丢失续接、超期重入、数量上限、全局编号以及人宠混合接口输出。真实运动检查使用 [VOT-LT2019 官方数据集](https://www.votchallenge.net/vot2019/dataset.html)的 `cat1` 和 `dog` 序列及逐帧人工框，从原始 30 fps 每 10 帧取一次，以 3 fps 和原始时间推进现有固定检测模型及宠物跟踪器。按可见目标框 IoU 至少 0.5 核对检测和实测轨迹，分别统计物种错误、2 秒内换号和超期后的重建；预测框不算检出。人工框直接驱动跟踪器的对照用于区分检测与关联问题。

这两段素材未通过连续跟踪质量检查：存在漏检、物种混淆和频繁换号，快速运动、小目标、镜头移动及遮挡尤其受限；人工框对照也存在换号，不能只归因于检测模型。资源与生命周期测试通过不代表真实宠物轨迹可靠。此检查只评估各序列指定的单个目标，不是 VOT 官方完整基准，也不能证明多猫狗交叉、其他未标注动物或家庭固定机位的质量；家庭实景和多宠验收仍待完成。公开素材、来源指纹、逐帧结果和带编号视频保存在 Git 忽略的 `data/perception/`，不把一次性报告纳入共享文档。

### 查询与有效性

`GET /api/perception` 和对应 SSE 的每路 `tracking` 与基础 `observation` 独立更新。两者通过来源运行和 `sequence` 关联，不能假定它们始终属于同一帧。`trackingValidity` 独立表达 `no_data / valid / expired / unavailable`；期限仍使用该帧的 `maxFrameAgeMs`，晚到或旧运行结果拒收。

- `status` 为 `tracked`、`degraded` 或 `failed`；外观模型尚未就绪、忙、预算不足或失败时为降级，允许仅凭位置和重叠关联，特征明确缺失。
- 轨迹 `state=measured` 时有本帧 `measuredBox`；`state=predicted` 时该字段为 `null`。`predictedBox` 始终是滤波预测/修正后的状态，可能越出画面，不能当成实际检出框。两者都使用原解码图像坐标，图像尺寸随结果返回。
- 跟踪的 `receivedAt / sampledAt` 沿用对应检测帧的本机接收时间，`mediaTime: null` 明确没有可信拍摄时间；不能据此保证跨摄像头拍摄同步。
- `lastMeasuredAt` 为最后实测帧的本机接收时间，预测期间保留原值，不因系统时钟校正重新换算；`feature` 区分人体的 `extracted / reused / missing` 与宠物的 `not_applicable`，`featureAt` 为最近实际提取时间。预测或本帧缺失特征不会刷新它。
- `skippedFrames` 累计因同源跟踪仍在途或帧龄超限跳过的输入；仅缺少外观帧副本时仍输出几何轨迹，不计为整帧跳过。没有新跟踪输入时旧结果自行过期，不补发旧像素。外观向量仅留在本地轨迹状态，不广播到查询接口。

### 离线策略校准

猫狗策略的离线校准入口为 `bun run --cwd apps/backend evaluate:pets`，对照固定区域检测、低分框续接与跨帧确认。输入布局、参数网格和指标含义见[宠物对照评估](../apps/backend/scripts/perception-evaluation/README.md)。线上仍采用上述默认参数；评估用低分候选和区域推理不通过当前摄像头配置启用。单目标标注的未匹配框数量不能直接解释为误报率。

候选模型的独立比较入口为 `bun run --cwd apps/backend evaluate:models`，使用人工核对的室内图片和完整人猫狗标注，分别报告检测精确率、召回率及同机耗时，见[室内模型对照](../apps/backend/scripts/perception-evaluation/README.md#室内检测模型)。它不修改正式模型，不以户外单目标跟踪分数推断室内检测效果。

### 计算与像素所有权

检测把像素转移给 Piscina 前，跟踪分支按容量复制对应原帧；全计算进程最多保留 2 帧、每路最多 1 帧，每帧最多 3840×2160 RGB24，逻辑保留上限约 47.46 MiB。保留期限不超过该帧 `maxFrameAgeMs`，到期释放像素名额。名额按等待来源先后轮转，只保存有期限的来源资格，不排队保存像素；来源停止或资格过期即移除。未取得副本时仍处理本帧检测框：猫狗继续位置关联，人体可复用已有合格特征或明确报告缺失特征；检测结束后不能拿更新帧替代。停止或运行替换使结果立即失去发布资格，并释放本地保留像素；已提交外观进程的在途副本在原任务期限内结束并回收。

首次出现需要特征的人体时才启动一个独立 ReID 子进程，sharp 与 ONNX 均使用单线程。它从启动时计算的 N 个推理并发预算中预留 1 个，基础检测仍至少保留 1 个并发名额；N=1 时只输出位置跟踪并报告外观不可用。申请预留后，检测调度立即将后续执行上限降为 N−1，让已经接纳的检测与等待任务自然排空，不取消或拒绝它们；实际执行中的检测不超过 N−1 时才允许启动 ReID，避免持续负载抢回外观名额。预留保持到计算进程关闭，检测模型会话仍为 N 个，但最多 N−1 个同时执行。纯图片任务和从未需要人体特征的视频仍使用全部 N 个检测并发。

ReID 最多一项在途请求、每项最多 8 个裁切，无等待队列；初始化期限 30 秒，单项期限取 1 秒与帧剩余有效期的较小值。ReID 的 IPC 副本最多另加一帧，裁切/模型工作区和常驻模型内存另计；CPU 比例不是宿主 RSS 硬配额。基础检测不等待特征，ReID 忙时该跟踪输入使用缺失特征。外观进程故障或超时只终止自身，当前计算运行内不自动重启；需重启 backend 或重建计算运行恢复。正常关闭确认子进程退出，外层计算进程组的强制回收也覆盖它。

### 验证范围

已核对真实模型张量、BGR 原始像素和裁切边界、128 维 L2 归一化、独立进程退出及硬期限。专项测试覆盖外观区分的交叉、遮挡、实际时间预测、超期重入、静止复用、缺失特征、轨迹上限、原帧转移、停止后晚到结果和独立有效期。双路视频链路使用固定室内人物图片（`000000465549.jpg`）编码的 H264 循环媒体，核对真实检测和 ReID、公开查询、外观进程故障时基础检测继续，以及关闭回收。

真实运动参考采用 [MOT15 官方 TUD-Stadtmitte 视频与人工标注](https://motchallenge.net/data/MOT15/)及 [OpenCV 4.12.0 的 vtest.avi](https://github.com/opencv/opencv/blob/4.12.0/samples/data/vtest.avi)。近距离 TUD 样本每 8 帧取一次（25 fps 原片，共 23 个样本），专项回归要求至少 100 个实测框与人工框的 IoU 达到 0.5，且同一人工目标在 2 秒内再次匹配时不能切换编号；此范围已通过。超过失配期限后重新建轨迹允许新编号，不当作身份延续。

TUD 原片 SHA-256 为 `057efff329eb73f3434649f9b21b37d0d3ca7de8f194524140161e2d13a6ae33`，MOT15Labels 中 `train/TUD-Stadtmitte/gt/gt.txt` 的 SHA-256 为 `009b3ef8df68c963fd8104350083fd6bc9798b6b435858b99dbd1385cfbde873`。测试显式传入这两个文件，缺少时跳过，不自动下载；素材与逐帧记录留在 Git 忽略的 `data/perception/`。

这不是完整 MOT 基准成绩，也不是跨场景可靠性保证。远距离 vtest 样本仍有明显人体漏检与轨迹中断；使用人工框隔离检测后，密集交叉仍存在关联错误，外观相似和遮挡不能保证编号连续。本机已测双路公开视频短时并行运行的检测时效和计算进程树（包括解码与 ReID）的 CPU/RSS，原始采样保存在本地验收材料中；它不包含模拟媒体服务之外的完整家庭接入负载。真实家庭双摄 P1+P2 与长时运行尚未测量，P1 的双摄结论不能自动扩大到 P2；剩余验收见[媒体计划](plans/media-perception.md#p2-剩余验收)。

```sh
bun test apps/backend/tests/perception/tracking.test.ts apps/backend/tests/perception/pet-tracking.test.ts apps/backend/tests/perception/tracking-runtime.test.ts
ORT_DISABLE_TELEMETRY=1 bun test apps/backend/tests/perception/reid-native.test.ts
ORT_DISABLE_TELEMETRY=1 PERCEPTION_INDOOR_DATA_DIR="$PWD/data/perception/model-comparison/indoor" bun test apps/backend/tests/perception/video-lifecycle.test.ts -t 'P2 real detection'
ORT_DISABLE_TELEMETRY=1 PERCEPTION_TUD_VIDEO_PATH=/path/to/TUD-Stadtmitte-raw.mp4 PERCEPTION_TUD_LABELS_PATH=/path/to/gt.txt bun test apps/backend/tests/perception/tracking-quality.test.ts
```

## 模型与参考

| 项目                     | 值                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| 资产                     | MiLoCo `perception/models/det_4C.onnx`                                                             |
| SHA-256                  | `eb55fff61225c1e4d90312a0f70f675ce19632bae1b51b948a3c8dc96765bf2f`                                 |
| 参考提交                 | `cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8`                                                         |
| 参考实现                 | `backend/miloco/src/miloco/perception/engine/identity/tracker/detector.py`                         |
| 输入                     | `images`，float32，`[1,3,416,416]`                                                                 |
| 输出                     | `output0`，float32，`[1,9,3549]`                                                                   |
| 类别顺序                 | human / cat / dog / head / face                                                                    |
| 置信度 / 同类框 IoU 阈值 | `0.5` / `0.7`                                                                                      |
| 许可依据                 | MiLoCo checkout 的 `LICENSE.md`；未找到该资产单独的许可声明，不假定它采用 ONNX Runtime 的 MIT 许可 |

使用资产时保留其来源和许可条款。MiLoCo 仓库许可证含非商业用途及应用开发限制。命令输出实际文件哈希，可与上表核对；程序校验张量类型与形状，不将文件名作为正确性的证明。

## 处理与资源边界

```text
检测调用方 → 计算子进程 → Piscina → 读取/解码/模型推理
           ← 尺寸、检测框、输入哈希与耗时 ←

独立图片命令取得检测结果
  → 重新读取并核对输入哈希 → sharp 画框与 PNG 编码
  → write-file-atomic 保存最终标注图
```

Piscina 负责线程和任务队列；子进程负责隔离原生崩溃。父子进程通过 IPC（进程间通信）传递请求和结果。硬超时由 backend 回收整个计算子进程。

- `detection/detector.ts` 负责预处理、推理、框还原和 NMS（移除同类重叠框）；不依赖家庭领域或媒体协议。
- `detection/image-request.ts` 定义文件任务边界、压缩图片字节上限和可独立处理的图片错误；`detection/image.ts` 提供有界图片加载和文件检测，只依赖检测器的 `detect` 能力；`detection/model.ts` 在子进程中计算模型指纹。文件任务只接受本地普通文件，压缩字节不超过 32 MiB，输入尺寸和可选缩放后的尺寸均受帧限额约束。
- `detection/frame.ts` 的 `frameLimits` 和 schema（结构校验规则）统一定义 RGB24 帧格式及接收限额，与计算线程配置分开。宽高各不超过 8192，总像素不超过 `3840 × 2160`（8,294,400）；单帧 RGB 最多约 23.73 MiB。原始帧超过像素预算或使用共享内存时在入队前拒绝，不触发恢复。原始帧入口供媒体解码器接入；图片命令使用子进程内的文件任务入口。
- sharp 使用显式 `kernel: "linear"` 和 `fit: "fill"` 缩放至已计算尺寸，按比例缩放后取整尺寸，每条边至少保留 1 像素（包括极端细长图），居中补 114，转换成归一化 float32 NCHW（批次、通道、高、宽）张量。MiLoCo 从 BGR 转 RGB；此接口已是 RGB，不重复交换通道。
- 取每个候选框的最高类别分数，保留分数至少 0.5 的框。按原比例去补边，把连续框端点裁到 `[0,width]`、`[0,height]`；按置信度降序，用连续坐标计算 IoU（交并比），仅抑制同类 IoU 至少 0.7 的框。筛选结束后，保留框的左上角向下取整、右下角向上取整，宽高由整数端点相减；取整保留边缘像素，不参与 NMS 判定。
- `compute/pool.ts` 管理一个常驻计算子进程，`compute/process.ts` 在 backend 主线程统一限制活跃检测子进程数量为 1；第二次建池直接失败，调用方应共享同一个池。名额只在实际退出或确认启动失败后释放，IPC 断开不释放。文件处理和原始帧计算共享最多 N 项执行、一项等待的容量（N 为启动时的 worker 数）；计算容量满返回 `busy`。检测结果返回后释放计算名额；计算池不接收标注或输出路径。`compute/process.ts` 使用官方 `child_process.fork()` 接口，以当前 Bun 可执行文件启动子进程；消息由 `compute/protocol.ts` 校验。文件任务只传路径、选项和结果，原始帧使用高级 IPC 序列化传递 RGB 字节。图片传输最多保留 N + 1 项请求；实际图片/视频计算准入统一由子进程的 `inference-pool.ts` 管理。视频不提前填充计算等待队列，使用每路最新帧和就绪来源轮转。有摄像头待处理时暂缓新的图片排队，让已有队列排空，避免持续图片请求使视频得不到计算机会；这类请求返回 `busy`。视频 IPC 控制请求最多同时 16 项。
- `compute/budget.ts` 定义启动 CPU 预算和固定的线程内并发限制。整个 backend 主线程最多拥有一个计算子进程，子进程内创建 N 个模型 worker。sharp 每图并发、ORT 算子内线程数均为 1；ORT 使用 `sequential`。不将 worker 数再乘入模型内部线程数。
- `compute/process-entry.ts` 组装计算子进程；`compute/inference-pool.ts` 统一准入与派发。每个 worker 由独立的单线程 Piscina 实例持有，使用 `minThreads: 0`、`maxThreads: 1`、`idleTimeout: Infinity`；这样初始化和释放可以明确送达每一个模型会话。启动时全部初始化成功且模型元信息一致才报告就绪。全池只保留一个待处理图片任务，由下一个空闲 worker 接手；视频仅在有空闲名额时取走最新帧。关闭时先停止接收任务、排空全部在途与已接纳等待任务，再逐 worker 释放模型并关闭空闲线程。任意 worker 的池级故障由监督者回收整个计算进程组，确认退出后按相同启动预算重建。
- backend 的 `dev`、`start`、`detect:image` 命令在进程启动时设置 `ORT_DISABLE_TELEMETRY=1` 关闭原生遥测；直接执行构建产物时也需设置此变量，依据 [ONNX Runtime 隐私说明](https://github.com/microsoft/onnxruntime/blob/main/docs/Privacy.md)。

`scripts/perception-annotation.ts` 负责开发命令的标注图片。它在独立 CLI 进程中加载 sharp，按检测结果尺寸重新解码原图，核对输入哈希，画框并编码完整 PNG，再用项目已有的 `write-file-atomic` 保存。输出采用临时文件和重命名完成替换，失败由图片命令报告。命令串行处理图片；不建立跨检测池的文件预约、输出状态或清理重试接口。导出耗时不计入检测任务期限或 `timing.totalMs`。导出异常可能中断本次开发命令，但不会通过检测协议使共享推理 worker 失效。

文件检测的像素留在推理线程，不跨 IPC 往返。原始帧入口的父子进程 IPC 仍复制像素，Bun 的高级 IPC 序列化不支持转移缓冲区所有权；子进程通过 Piscina 的 `run(task, { transferList })` 把其独占副本交给工作线程，不再复制一份。这里的转移只发生在线程边界，不能消除父子进程间的复制。[Bun IPC](https://bun.com/docs/runtime/child-process#inter-process-communication-ipc)、[Piscina 任务参数](https://piscinajs.dev/api-reference/Methods/)

调用方原始缓冲区保持有效；原始帧检测 Promise 完成前不得修改像素。若输入只是较大底层缓冲区的局部视图，发送前用 `new Uint8Array(rgb)` 显式复制有效范围（包括 Buffer 输入），避免传输隐藏的大缓冲区。

单个 backend 主线程最多一个活跃计算子进程、N + 1 项图片/原始帧 IPC 请求；持续视频只传控制和结果，每路最多一个未完成任务。RGB 帧传输的逻辑像素预算最多为 `(N + 1) × 23.73 MiB`，IPC 副本另计；最多 N 个 worker 同时持有图片处理工作区和独立模型会话。独立图片命令仍按张串行提交，输出编码在命令进程内完成。这些限额不是 RSS 硬配额；增加比例会增加模型初始化时间及内存占用。不同 backend 进程的总资源由部署配置限制。

## 分段耗时

每个成功检测结果的 `timing` 包含以下毫秒值。文件任务计入完整读取、解码与检测；原始帧任务未执行的文件阶段记为 0：

| 字段                                             | 测量范围                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `totalMs`                                        | 调用 `detect()` 或 `detectImage()`、开始输入校验，到调用方取得完整任务结果           |
| `readMs`                                         | 文件读取与图片哈希计算；模型哈希属于初始化，不逐帧重复                               |
| `decodeMs`                                       | 图片信息核对、解码、可选输出尺寸缩放和 RGB24 整理                                    |
| `preprocessMs` / `inferenceMs` / `postprocessMs` | 模型预处理、推理、输出检查与框后处理                                                 |
| `queueMs`                                        | 任务在 Piscina 等待队列中的累计驻留时间；直接分发为 0                                |
| `ipcRoundTripMs`                                 | 父进程发送至收到回复的耗时，减去子进程接收至准备回复的处理耗时                       |
| `workerDispatchMs`                               | Piscina 调用耗时，减去实际排队与推理线程内完整执行耗时                               |
| `dispatchMs`                                     | `totalMs` 减去读取、解码和模型三个阶段的汇总值；不与其包含的排队、传输等分段重复相加 |

输入在公开计算池入口校验，IPC 请求与响应在各自接收端校验；同一进程内的发送端和推理内部调用不重复解析已校验的数据。图片解码器限制文件与像素规模，检测器检查模型输入输出契约。

阶段计时用于定位瓶颈，不要求各段相加等于总耗时；输入校验、局部像素复制和资源释放仍计入总耗时，不逐项累计或计算剩余开销。各进程和线程只测量自身持续时间，不直接相减不同进程的 `performance.now()` 时间戳。`ipcRoundTripMs` 包含双向序列化、传输和两端消息调度，不能解释成纯字节传输耗时；`workerDispatchMs` 包含线程传输和 Piscina 回调调度。差值按 0 截断，避免计时精度误差产生负值。分位数分别计算，不能将各段 P95 相加当作总耗时 P95。

`compute/inference-queue.ts` 通过 Piscina 的公开 `taskQueue` 与 `queueOptionsSymbol` 接口记录 worker 内部排队时间，汇总时再加上全池等待空闲 worker 的时间。被取出后重新入队的任务累计每一段等待，移除任务时清理记录，不读取 Piscina 私有字段。[Piscina 自定义队列接口](https://piscinajs.dev/advanced-topics/Custom%20Task%20Queues/)

## 运行范围与限制

当前已验证的运行环境为 Bun 1.4.2 / macOS arm64 / CPU，支持源码和构建产物入口。Linux、GPU 和全天摄像头连续运行尚未验证，不在当前 P1 完成结论的覆盖范围内。持续视频要求 POSIX 进程组支持；当前不支持 Windows 宿主。实际任务超时、计算子进程异常退出、重建和正常关闭已在当前 Mac 环境核对。

图片解码、缩放和标注统一使用 sharp，模型张量整理和补边由 TS 完成。预处理参数明确固定，不要求与 MiLoCo 逐像素一致；模型契约和实际检测效果是正确性依据，不保证遮挡或画面边缘目标的检出率。

## 计算池接口与故障行为

`createDetectionPool(options?)` 加载内部常量指定的 `det_4C.onnx`，返回 `metadata`、`detect(frame)`、`detectImage(input)`、`retry()`、`close()` 和 `getStatus()`。它负责这一固定检测模型的生命周期，不提供任意模型选择接口。导入和使用计算池不会在主线程加载 sharp 或 ONNX Runtime。帧边界定义在 `detection/frame.ts`；文件任务边界定义在 `detection/image-request.ts`。

`detectImage({ path, resize? })` 接受图片路径和可选的 `{ width, height }` 检测尺寸。输入为严格对象，未知字段会被拒绝。相对路径按调用进程工作目录解析；指定缩放时采用 `fill/lanczos3`，检测框对应返回的输出尺寸，默认对应原图。正常结果为 `image_detected`，只返回哈希、尺寸、框和路径，不返回整张 RGB 图片。`detect(frame)` 返回 `detected`，保留媒体解码器的原始帧接入能力。

计算子进程的 Piscina worker 内完成模型指纹、加载与推理；`metadata` 返回最近一次成功初始化的 `modelPath`、`sha256`、张量及执行配置，恢复成功后更新，`workerThreadIds` 列出该计算进程内全部已初始化工作线程，结合 `processId` 判断运行身份。

| 配置                  | 默认值 | 含义                                                                     |
| --------------------- | ------ | ------------------------------------------------------------------------ |
| `initializeTimeoutMs` | 30000  | 每次模型初始化的等待期限                                                 |
| `taskTimeoutMs`       | 10000  | 一次任务从提交起的期限，包含排队及完整文件处理                           |
| `closeTimeoutMs`      | 10000  | 完整关闭期限；也用于恢复前确认旧进程已退出                               |
| `recoveryDelayMs`     | 250    | 第一次重建前的等待，后续按两倍增加                                       |
| `maxRestarts`         | 2      | 连续故障期间的自动重建次数上限                                           |
| `recoveryResetMs`     | 60000  | 成功检测持续覆盖此时长后重置连续重建预算；仅空闲等待或模型加载成功不重置 |

初始化失败会清理本次子进程并拒绝创建。模型加载、张量契约校验和线程初始化失败通过故障消息保留具体原因；池级故障保留收到的底层原因。文件打不开、超过输入预算或解码失败返回 `invalid_image`，只结束当前任务，不消耗模型重建次数。推理或模型输出契约错误仍视为计算故障；任一类别置信度非有限数或超出 `[0,1]`、坐标非有限数都会拒绝本次结果，不能把异常输出当作成功的空检测。

检测任务超时、计算进程错误或退出、IPC 断开都会使当前计算运行失效，旧任务失败。输入文件读取和解码仍属于检测任务，其卡住或超时也会触发计算恢复。失败任务不会自动重放，恢复期间新请求返回不可用。只有实际子进程 `exit` 和整个计算进程组退出都已确认后才按预算重建；发送信号、IPC 断开和结束等待都不能代替退出确认。无法确认退出时保持不可用，不叠加新进程。输入格式错误和队列满不触发重建。

`retry()` 恢复已暂停的计算池，重置连续重建预算；即使自动重建次数设为 0，也允许一次显式尝试。并发调用合并到同一次恢复，仍先确认旧进程退出。关闭后不能重试。正常运行期间，连续成功检测跨越 `recoveryResetMs` 后才重置预算，任一计算故障重新开始稳定时长计量。

`getStatus()` 返回状态、累计重建次数 `restarts`、连续重建次数 `consecutiveRestarts`、最近错误、当前代 `processId`、在途检测数 `activeRequests`、其中的文件任务数 `activeImageRequests`，以及原始帧逻辑像素字节数 `activeRgbBytes`。文件任务通过路径提交，不计入 `activeRgbBytes`，这不代表子进程内没有图片内存。PID 用于诊断，不单独证明进程仍存活。状态包括 `starting`、`ready`、`recovering`、`unavailable`、`closing`、`closed`。`DetectionPoolError.code` 区分 `timeout`、`closed`、`busy`、`unavailable`、`worker_failed` 和 `invalid_image`；输入不符合 schema 时由 Zod 校验错误报告。

关闭立即停止恢复重试。完整关闭期限的前半段用于等待检测、恢复收尾和 session 释放，剩余预算用于确认子进程退出及请求结束。正常释放超时或运行故障时，对该计算子进程发送 `SIGKILL` 并等待实际 `exit`。正常释放超时但后续回收确认完成时，`close()` 报错而状态为 `closed`；退出或请求清理无法确认时为 `unavailable`。关闭只处理计算资源，不等待独立图片命令的导出。父连接断开时，子进程在事件循环恢复执行后退出；宿主异常退出且原生调用永久卡住的进程树清理仍需要部署环境的进程监督机制。

## 运行边界的依据

原生推理期间强制终止 JavaScript worker 可能使 ONNX Runtime 的原生绑定在失效的运行环境上继续工作，进而中止整个进程；当前资产与依赖在 Bun 和 Node 的线程终止复现中均出现进程崩溃。计算采用独立 OS 进程，使超时回收和原生崩溃不直接终止 backend。保留 Piscina 管理计算队列，但不对执行中的原生任务调用 `AbortSignal` 或 `Piscina.destroy()`；正常释放后才关闭空闲线程。

- [Piscina 方法文档](https://piscinajs.dev/api-reference/Methods/)区分等待任务的 `close()` 和中止任务的 `destroy()`；本实现把硬终止交给外层进程边界。
- [Bun Worker 文档](https://bun.com/docs/runtime/workers)说明线程终止仍属于实验性部分。
- [Node Worker 文档](https://nodejs.org/api/worker_threads.html)说明 `terminate()` 可在任意执行点停止线程；它不是 ONNX 推理的协作取消接口。
- [官方子进程接口](https://nodejs.org/api/child_process.html)提供独立进程和 IPC。发送终止信号不等于进程已经退出，资源回收以 `exit` 为准。
- [Bun IPC](https://bun.com/docs/runtime/child-process)支持父子 Bun 进程的高级序列化。本实现显式使用相同可执行文件，保持像素类型；进程传输会复制数据，应计入后续视频吞吐评估。

## 针对性验证入口

无需模型的生命周期与进程边界测试位于 `tests/perception/pool.test.ts`、`process.test.ts`、`process-ipc.test.ts` 和 `inference-pool.test.ts`；`annotation.test.ts` 核对完整标注图、原图变更、写入失败和导出卡住时的检测与关闭隔离；该文件使用真实模型；`inference-queue.test.ts` 核对实际排队、重新入队和移除任务的计时；`detector.test.ts` 核对颜色、补边、边界框、连续坐标 NMS、取整输出和资源释放；`image.test.ts` 核对图片有界读取、哈希、解码、缩放、任务错误及检测像素与输入哈希的一致性；`report.test.ts` 核对报告不重新打开模型文件，以及基准漏投统计。真实模型集成测试使用项目内固定模型，显式运行：

```sh
ORT_DISABLE_TELEMETRY=1 bun test apps/backend/tests/perception/native-process.test.ts
```

真实模型测试覆盖独立 PID、图片检测链路、计算池调用方不加载原生图片/推理库、坏图片不重建模型、超时回收后的模型重载、计算子进程异常中止后调用方继续运行并重新检测，以及模型加载失败保留原因并释放进程名额。验证范围不等于保证所有平台和任意原生故障均可恢复。

检测质量的主要回归集由 `tests/perception/detection-quality.test.ts` 核对：63 张人工筛选的 COCO 室内图片，包含 27 个人、25 只猫、27 只狗和 10 张无上述目标的图片。固定图片清单、来源、SHA-256 和官方标注保存在 `tests/perception/fixtures/indoor-manifest.json`；图片放在外部数据目录的 `images/` 中，不随测试下载或纳入仓库。清单中的来源 URL 可用于准备素材；测试逐张核对指纹与尺寸。

```sh
ORT_DISABLE_TELEMETRY=1 PERCEPTION_INDOOR_DATA_DIR="$PWD/data/perception/model-comparison/indoor" bun test apps/backend/tests/perception/detection-quality.test.ts
```

测试经过正式检测池，使用当前固定模型和默认置信度 0.5；按同类框交并比（IoU，即交集面积除以并集面积）至少 0.5 做一对一匹配。防退化门槛为人／猫／狗分别至少匹配 20／22／25 个、误报不超过 1／0／1 个，无目标图片中出现误报的不超过 1 张。门槛记录现有能力，不是家庭场景合格标准；静态照片不能验证连续跟踪、夜间摄像头或遮挡后的身份恢复。未设置数据目录时显式跳过，设置后缺图或指纹不符会失败。

`native-process.test.ts` 另检查纯色帧不产生目标。户外运动素材仍用于跟踪的补充回归，不能替代室内连续录像验收。

## 连续输入性能测量

```sh
bun run --cwd apps/backend benchmark:perception --seconds 20 /path/to/image.jpg
```

基准在 macOS/Linux 上使用真实模型，以 `workload.kind = "image-file"` 标识文件任务，分别按 1080p／10 fps、4K／10 fps、4K／30 fps 提交路径与目标尺寸。每次任务都在子进程读取、计算哈希、按 `fill/lanczos3` 解码缩放并检测，父进程不持有预解码 RGB。每组预热 5 帧，输出一行 JSON；`--seconds` 设置每组持续时间（5–300 秒）。总耗时包含文件读取、哈希和解码，同一池跨三组复用。输入可换成实际摄像头截图，运行期间输入哈希变化会使基准失败。

比较报告时先核对输入模式和计时范围。文件任务的完整处理耗时，不能与预解码 RGB 帧的入队检测耗时直接比较，也不代表摄像头持续解码吞吐。

帧计划按单调时钟推进，统计 `planned`（计划帧数）、`offered`（实际提交帧数）和 `missedDueToEventLoop`（定时回调迟到而未提交的帧数）。回调迟到时只提交最新到期帧，不集中补发历史帧；`planned = offered + missedDueToEventLoop`。已提交任务中的队列满拒绝另计为 `busy`，不能与未提交帧或成功帧混为一类。检测延迟仅描述已接收且完成的任务，应同时查看漏投、拒绝和实际吞吐。

每行报告在 `metadata` 中统一记录模型路径、哈希、张量信息及实际执行后端，另含输入图片路径与哈希、CPU 型号、系统版本和运行环境、ORT/Piscina/sharp 版本、计算预算和输入限额，便于核对比较条件；系统未提供 CPU 型号时为 `null`。`scripts/perception-report.ts` 为图片命令和基准共用的报告入口，使用子进程提供的模型元信息，父进程只读取依赖版本和宿主环境。

报告还包括检测端到端、读取、解码、模型三个阶段，以及排队、IPC 往返与线程分发各自的 p50/p95/p99/max、完成吞吐、10ms 主线程定时器的额外延迟，以及每 250ms 采样的父/子进程 RSS（操作系统统计的驻留内存）。基准不执行标注导出。RSS 报告为采样峰值，可能漏掉瞬时尖峰；主线程定时器延迟是响应性代理指标，不是 HTTP 响应时间。内存首尾四分之一均值帮助发现持续增长，不能单次据此断言泄漏。内存采样失败或非过载任务错误会让命令失败，不把缺失数据当零占用。

NMS 保持同类、按置信度排序的抑制规则，不为降低计算量截断候选或改变检测结果。用报告的 `postprocessMs` 判断该阶段是否值得进一步优化；固定图片短期测量不覆盖密集场景或全天摄像头稳定性。
