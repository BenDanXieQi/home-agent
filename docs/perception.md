# 本地目标检测

本地检测模块使用 Bun 管理的独立计算子进程、Piscina 线程池和 ONNX Runtime CPU 执行 `det_4C.onnx`，接受图片文件任务或 RGB24 帧，返回人体、猫、狗、头部和人脸检测框。文件读取、哈希、解码、缩放、检测及标注 PNG 的暂存都在计算子进程中执行；调用进程接纳任务结果后发布最终文件，不加载 sharp 或 ONNX 原生库。检测结果是画面证据，不表示房间在场或人员身份。

## 安装与使用

在仓库根目录运行 `bun install`。模型不纳入仓库，运行时不下载。取得已有 MiLoCo checkout 中的 `backend/miloco/src/miloco/perception/models/det_4C.onnx`，使用原路径或自行复制到本地 `data/models/`；路径显式传入命令。

`patches/piscina@5.3.2.patch` 修正 Piscina 的 `TransferList` 类型声明：从 Node 的 `StructuredSerializeOptions.transfer` 推导数组类型，避免从 `MessagePort.postMessage` 的重载错误推导成选项对象。Bun 安装时通过 `patchedDependencies` 自动应用；补丁不改运行时 JavaScript，使直接传入 `transferList` 能通过类型检查，无需类型断言。升级 Piscina 时需核对声明并移除已被正式版本覆盖的补丁。[Bun 补丁机制](https://bun.com/docs/pm/cli/patch)

```sh
bun run --cwd apps/backend detect:image --output-dir ../../data/perception /path/to/det_4C.onnx /path/to/image.jpg
```

可传入多张图片；同一个模型 session 顺序处理，最后释放 session 并关闭计算池。`--output-dir` 可省略；指定时保存带框 PNG。标准输出为 JSON Lines（每行一个 JSON 对象）：首行为模型路径、SHA-256、输入输出元信息、运行环境、依赖版本及资源预算，其后每行是 `image_detected` 结果，包含 `imagePath`、`inputSha256`、尺寸、检测框、分段耗时及可选的 `annotatedImage` 路径。图片按存储像素方向解码，不应用 EXIF 旋转。模型指纹在子进程初始化时计算；图片在子进程有界读取一次，用同一份字节计算哈希并解码。运行期间不修改模型和输入图片。

```sh
bun run --cwd apps/backend build:perception
ORT_DISABLE_TELEMETRY=1 bun apps/backend/dist/detect-image.js /path/to/det_4C.onnx /path/to/image.jpg
```

backend 的 `build` 同时构建计算子进程入口与图片命令，并生成 source map（将构建后的报错位置映射回源码）。图片命令不要求数据库、摄像头、go2rtc 或 LLM。本模块尚未接入摄像头持续采集和家庭上下文，也没有检测结果的 HTTP/前端入口；后续范围见[实施计划](plans/miloco-perception-alignment.md)。

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

使用资产时保留其来源和许可条款。MiLoCo 仓库许可证含非商业用途及应用开发限制；这里不重新分发模型。命令输出实际文件哈希，可与上表核对；程序校验张量类型与形状，不将文件名作为正确性的证明。

## 处理与资源边界

```text
Bun 调用进程 ──路径与选项──→ 计算子进程 → Piscina → 推理线程
                                                   读取/哈希/解码/检测/暂存 PNG
             ←──────────── 检测结果与暂存完成确认 ─────────────┘
       接纳结果 → 重命名发布最终文件 → 返回成功
```

Piscina 负责线程和任务队列；子进程负责隔离原生崩溃。父子进程通过 IPC（进程间通信）传递请求和结果。硬超时由 backend 回收整个计算子进程。

- `detection/detector.ts` 负责预处理、推理、框还原和 NMS（移除同类重叠框）；不依赖家庭领域或媒体协议。
- `detection/image-request.ts` 定义文件任务边界、压缩图片字节上限和可独立处理的图片错误；`detection/image.ts` 读取、处理图片并生成暂存 PNG，只依赖检测器的 `detect` 能力；`detection/model.ts` 在子进程中计算模型指纹。文件任务只接受本地普通文件，压缩字节不超过 32 MiB，输入尺寸和可选缩放后的尺寸均受帧限额约束。
- `detection/frame.ts` 的 `frameLimits` 和 schema（结构校验规则）统一定义 RGB24 帧格式及接收限额，与计算线程配置分开。宽高各不超过 8192，总像素不超过 `3840 × 2160`（8,294,400）；单帧 RGB 最多约 23.73 MiB。原始帧超过像素预算或使用共享内存时在入队前拒绝，不触发恢复。原始帧入口供媒体解码器接入；图片命令使用子进程内的文件任务入口。
- sharp 使用显式 `kernel: "linear"` 和 `fit: "fill"` 缩放至已计算尺寸，按比例缩放后取整尺寸，每条边至少保留 1 像素（包括极端细长图），居中补 114，转换成归一化 float32 NCHW（批次、通道、高、宽）张量。MiLoCo 从 BGR 转 RGB；此接口已是 RGB，不重复交换通道。
- 取每个候选框的最高类别分数，保留分数至少 0.5 的框。按原比例去补边，把连续框端点裁到 `[0,width]`、`[0,height]`；按置信度降序，用连续坐标计算 IoU（交并比），仅抑制同类 IoU 至少 0.7 的框。筛选结束后，保留框的左上角向下取整、右下角向上取整，宽高由整数端点相减；取整保留边缘像素，不参与 NMS 判定。
- `compute/pool.ts` 管理一个常驻计算子进程，`compute/process.ts` 在 backend 主线程统一限制活跃检测子进程数量为 1；第二次建池直接失败，调用方应共享同一个池。名额只在实际退出或确认启动失败后释放，IPC 断开不释放。文件任务和原始帧共享最多一项执行、一项等待的容量；队列满直接拒绝。`compute/process.ts` 使用官方 `child_process.fork()` 接口，以当前 Bun 可执行文件启动子进程；消息由 `compute/protocol.ts` 校验。文件任务只传路径、选项和结果，原始帧使用高级 IPC 序列化传递 RGB 字节。当前队列为先进先出，不提供最新视频帧替换。
- `compute/budget.ts` 统一定义一个进程、一个 Piscina worker、每 worker 一项任务、一项排队及 sharp 与 ORT 预算。sharp 每图并发、ORT 算子内线程数均为 1；ORT 按 `sequential` 顺序执行算子，不配置未启用的算子间线程池。检测器在推理线程内显式设置 `sharp.concurrency(1)` 并返回实际读值，图片解码和标注使用同一进程配置。
- `compute/process-entry.ts` 接收 IPC；`compute/inference-pool.ts` 管理 Piscina；`compute/inference-worker.ts` 持有唯一模型 session（可复用的推理会话），串行执行任务。Piscina 设置 `minThreads: 0`、`maxThreads: 1`、`idleTimeout: Infinity`，不自行补建故障线程；恢复由外层统一负责。当前代码显式要求一个 worker、每 worker 一项任务；多 worker 需要逐个会话初始化和释放，不能只修改预算数字。调用者必须在 `finally` 中执行 `close()`；重复关闭返回同一 Promise。正常关闭等待已接收任务、释放 session，再用 `Piscina.close()` 关闭空闲线程，最后回收子进程。超时回收整个计算子进程，不在原生推理中途强行销毁线程。
- backend 的 `dev`、`start`、`detect:image` 命令在进程启动时设置 `ORT_DISABLE_TELEMETRY=1` 关闭原生遥测；直接执行构建产物时也需设置此变量，依据 [ONNX Runtime 隐私说明](https://github.com/microsoft/onnxruntime/blob/main/docs/Privacy.md)。

此提交协议只用于可选的标注 PNG 导出，不用于实时检测观测、身份状态、语义事件或设备动作。未指定 `outputPath` 的任务不预约文件路径，也不进入文件提交流程。后续证据保存按其文件与引用关系设计，不直接套用覆盖标注文件的协议。

`detection/annotation-output.ts` 是标注输出的所有者，统一预约目标路径、分配同目录临时文件、提交与清理。子进程只能写临时 PNG，不能替换最终文件。父任务收到暂存完成结果后，在检查任务期限和当前运行仍有效的同一执行段内接纳结果并发起异步重命名；只有确认发布成功才返回 `annotatedImage`。未被接纳的任务超时或所属进程失效时，不发布最终文件；先确认子进程退出，再清理其临时文件，避免旧任务重新写入。

接纳后，发布不再受其他任务引起的计算进程失效撤销。异步文件重命名无法可靠取消：任务期限内尚未确认结果时，返回携带 `outputPath` 的 `output_commit_unknown`，表示最终文件可能已经替换，不能解释成普通超时或未写入。任务的容量名额和目标路径预约持续到文件操作真正结束，防止旧提交覆盖后来的同路径任务；旧池仍有未完成输出或清理时，同一 backend 主线程不能另建新池绕过限制。目标路径按 `resolve()` 规范化，同路径在途请求返回 `busy`；调用方应使用一致的路径，符号链接别名不作为同路径识别。该协议不提供父进程崩溃后的持久化提交查询。

文件任务的解码像素留在推理线程，检测后直接用于标注，不跨 IPC 往返。原始帧入口的父子进程 IPC 仍复制像素，Bun 的高级 IPC 序列化不支持转移缓冲区所有权；子进程通过 Piscina 的 `run(task, { transferList })` 把其独占副本交给工作线程，不再复制一份。这里的转移只发生在线程边界，不能消除父子进程间的复制。[Bun IPC](https://bun.com/docs/runtime/child-process#inter-process-communication-ipc)、[Piscina 任务参数](https://piscinajs.dev/api-reference/Methods/)

调用方原始缓冲区保持有效；原始帧检测 Promise 完成前不得修改像素。若输入只是较大底层缓冲区的局部视图，发送前用 `new Uint8Array(rgb)` 显式复制有效范围（包括 Buffer 输入），避免传输隐藏的大缓冲区。

单个 backend 主线程最多一个池、两项在途请求。全为原始帧时，接收的逻辑 RGB 数据合计最多约 47.46 MiB，IPC 接收副本另占同等空间。文件任务排队时只保存路径，执行时才有界读取和解码；只有一个任务持有图片处理工作区。模型、张量、图片编码缓冲区、sharp 缓存和运行时仍占内存，这些上限不是操作系统 RSS 硬配额。不同 backend 进程的总资源由部署配置限制。

## 分段耗时

每个成功检测结果的 `timing` 包含以下毫秒值。文件任务计入完整读取、解码、检测与可选保存；原始帧任务未执行的文件阶段记为 0：

| 字段                                             | 测量范围                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `totalMs`                                        | 调用 `detect()` 或 `detectImage()`、开始输入校验，到调用方取得完整任务结果                 |
| `readMs`                                         | 文件读取与图片哈希计算；模型哈希属于初始化，不逐帧重复                                     |
| `decodeMs`                                       | 图片信息核对、解码、可选输出尺寸缩放和 RGB24 整理                                          |
| `annotationMs`                                   | 可选框标注、PNG 编码、暂存和父任务发布；未请求输出文件时为 0                               |
| `preprocessMs` / `inferenceMs` / `postprocessMs` | 模型预处理、推理、输出检查与框后处理                                                       |
| `queueMs`                                        | 任务在 Piscina 等待队列中的累计驻留时间；直接分发为 0                                      |
| `ipcRoundTripMs`                                 | 父进程发送至收到回复的耗时，减去子进程接收至准备回复的处理耗时                             |
| `workerDispatchMs`                               | Piscina 调用耗时，减去实际排队与推理线程内完整执行耗时                                     |
| `dispatchMs`                                     | `totalMs` 减去读取、解码、标注和模型三个阶段的汇总值；不与其包含的排队、传输等分段重复相加 |

输入在公开计算池入口校验，IPC 请求与响应在各自接收端校验；同一进程内的发送端和推理内部调用不重复解析已校验的数据。图片解码器限制文件与像素规模，检测器检查模型输入输出契约。

阶段计时用于定位瓶颈，不要求各段相加等于总耗时；输入校验、局部像素复制和资源释放仍计入总耗时，不逐项累计或计算剩余开销。各进程和线程只测量自身持续时间，不直接相减不同进程的 `performance.now()` 时间戳。`ipcRoundTripMs` 包含双向序列化、传输和两端消息调度，不能解释成纯字节传输耗时；`workerDispatchMs` 包含线程传输和 Piscina 回调调度。差值按 0 截断，避免计时精度误差产生负值。分位数分别计算，不能将各段 P95 相加当作总耗时 P95。

`compute/inference-queue.ts` 通过 Piscina 的公开 `taskQueue` 与 `queueOptionsSymbol` 接口包装 FIFO（先入先出）队列，只记录排队时间，不改变调度顺序。被取出后重新入队的任务累计每一段等待，移除任务时清理记录，不读取 Piscina 私有字段。[Piscina 自定义队列接口](https://piscinajs.dev/advanced-topics/Custom%20Task%20Queues/)

## 运行范围与限制

当前已验证的运行环境为 Bun 1.4.2 / macOS arm64 / CPU，支持源码和构建产物入口。Linux、GPU、长时间摄像头连续运行尚未验证。实际任务超时、计算子进程异常退出、重建和正常关闭已在当前 Mac 环境核对。

图片解码、缩放和标注统一使用 sharp，模型张量整理和补边由 TS 完成。预处理参数明确固定，不要求与 MiLoCo 逐像素一致；模型契约和实际检测效果是正确性依据，不保证遮挡或画面边缘目标的检出率。

## 计算池接口与故障行为

`createDetectionPool(modelPath, options?)` 返回 `metadata`、`detect(frame)`、`detectImage(input)`、`close()` 和 `getStatus()`。导入和使用计算池不会在主线程加载 sharp 或 ONNX Runtime。帧边界定义在 `detection/frame.ts`；文件任务边界定义在 `detection/image-request.ts`。

`detectImage({ path, resize?, outputPath? })` 接受图片路径、可选的 `{ width, height }` 输出尺寸和标注保存路径。相对路径按调用进程工作目录解析；指定缩放时采用 `fill/lanczos3`，检测框对应返回的输出尺寸，默认对应原图。正常结果为 `image_detected`，只返回哈希、尺寸、框和路径，不返回整张 RGB 图片。`detect(frame)` 返回 `detected`，保留媒体解码器的原始帧接入能力。

计算子进程的 Piscina worker 内完成模型指纹、加载与推理；`metadata` 返回最近一次成功初始化的 `modelPath`、`sha256`、张量及执行配置，恢复成功后更新，`workerThreadId` 标识该次初始化所在的工作线程。

| 配置                  | 默认值 | 含义                                                 |
| --------------------- | ------ | ---------------------------------------------------- |
| `initializeTimeoutMs` | 30000  | 每次模型初始化的等待期限                             |
| `taskTimeoutMs`       | 10000  | 一次任务从提交起的期限，包含排队及完整文件处理       |
| `closeTimeoutMs`      | 10000  | 完整关闭期限；也用于恢复前确认旧进程已退出           |
| `recoveryDelayMs`     | 250    | 第一次重建前的等待，后续按两倍增加                   |
| `maxRestarts`         | 2      | 池整个生命周期的重建次数上限，不因一次成功恢复而归零 |

初始化失败会清理本次子进程并拒绝创建。模型加载、张量契约校验和线程初始化失败通过故障消息保留具体原因；池级故障保留失败退出码。文件打不开、超过输入预算或解码失败返回 `invalid_image`；标注或写文件失败返回 `output_failed`，只结束当前任务，不消耗模型重建次数。推理或模型输出契约错误仍视为计算故障，不被图片错误处理掩盖。

任务超时、计算进程错误或退出、IPC 断开都会使当前运行失效，尚未接纳输出提交的旧任务立即失败；已经接纳的文件提交继续独立等待确认。失败任务不会自动重放，恢复期间新请求返回不可用。只有实际子进程 `exit` 已确认、该代临时输出清理完成后才按预算重建；发送信号、IPC 断开和结束等待都不能代替退出确认。无法确认退出或无法清理临时输出时保持不可用，不叠加新进程。临时输出清理失败属于资源故障，不作为普通 `output_failed` 继续接收任务。输入格式错误和队列满不触发重建。

`getStatus()` 返回状态、已使用重建次数、最近错误、当前代 `processId`、在途请求数 `activeRequests`、其中的文件任务数 `activeImageRequests`、原始帧逻辑像素字节数 `activeRgbBytes`，以及正在提交的标注路径 `committingOutputs`。调用方已经收到 `output_commit_unknown` 的任务仍计入在途数量，直到实际文件操作结束。文件任务通过路径提交，不计入 `activeRgbBytes`，这不代表子进程内没有图片内存。`lastError` 包含底层原因摘要，便于区分模型错误与进程故障。PID 用于诊断，不单独证明进程仍存活。状态包括 `starting`、`ready`、`recovering`、`unavailable`、`closing`、`closed`。`DetectionPoolError.code` 区分 `timeout`、`closed`、`busy`、`unavailable`、`worker_failed`、`invalid_image`、`output_failed` 和 `output_commit_unknown`；提交参数不符合 schema 时由 Zod 校验错误报告。

关闭立即停止恢复重试。完整关闭期限的前半段用于等待任务、恢复收尾和 session 释放，剩余预算用于确认子进程退出、已接纳文件提交和临时文件清理。正常释放超时或运行故障时，对该计算子进程发送 `SIGKILL`，并等待实际 `exit`。正常释放超时但进程退出与文件操作均已确认结束时，`close()` 报错而状态为 `closed`；退出或文件清理未能确认时为 `unavailable`。仍有未确认发布时，`close()` 返回 `output_commit_unknown`，状态为 `unavailable`，目标路径仍被预约。父连接断开时，子进程在事件循环恢复执行后退出；宿主异常退出且原生调用永久卡住的进程树清理仍需要部署环境的进程监督机制。

## 运行边界的依据

原生推理期间强制终止 JavaScript worker 可能使 ONNX Runtime 的原生绑定在失效的运行环境上继续工作，进而中止整个进程；当前资产与依赖在 Bun 和 Node 的线程终止复现中均出现进程崩溃。计算采用独立 OS 进程，使超时回收和原生崩溃不直接终止 backend。保留 Piscina 管理计算队列，但不对执行中的原生任务调用 `AbortSignal` 或 `Piscina.destroy()`；正常释放后才关闭空闲线程。

- [Piscina 方法文档](https://piscinajs.dev/api-reference/Methods/)区分等待任务的 `close()` 和中止任务的 `destroy()`；本实现把硬终止交给外层进程边界。
- [Bun Worker 文档](https://bun.com/docs/runtime/workers)说明线程终止仍属于实验性部分。
- [Node Worker 文档](https://nodejs.org/api/worker_threads.html)说明 `terminate()` 可在任意执行点停止线程；它不是 ONNX 推理的协作取消接口。
- [官方子进程接口](https://nodejs.org/api/child_process.html)提供独立进程和 IPC。发送终止信号不等于进程已经退出，资源回收以 `exit` 为准。
- [Bun IPC](https://bun.com/docs/runtime/child-process)支持父子 Bun 进程的高级序列化。本实现显式使用相同可执行文件，保持像素类型；进程传输会复制数据，应计入后续视频吞吐评估。

## MiLoCo 的处理方式

参考提交的 `perception/inference_worker.py` 使用 Python 独立线程和 asyncio 事件循环，`runner.stop()` 调用 `shutdown(wait=False)`。它请求停止循环，不强制中断正在执行的 ONNX 调用；旧线程等原生调用自然结束，新一代可以先启动。因此没有这里强制终止 JavaScript worker、销毁 N-API 环境的同一触发路径，但不能据此认为原生推理不会崩溃。

其源码明确允许旧代尚未退出就启动新代。由此可推断：原生调用长时间不返回时，旧代资源可能继续占用；这是取消和回收保证的差异，并非本项目已实测出 MiLoCo 泄漏。当前实现要求实际计算子进程退出后才重建。

MiLoCo 的[官方发布记录](https://github.com/XiaoMi/xiaomi-miloco/releases)记载过推理线程泄漏、CoreML 临时模型文件泄漏，以及通过升级 ONNX Runtime 1.27 修复 KleidiAI 卷积工作区内存泄漏；[2026.9.11 发布说明](https://github.com/XiaoMi/xiaomi-miloco/releases/tag/v2026.9.11)还记录过摄像头原生库导致进程 SIGSEGV（非法内存访问）的故障。这些证明原生资源和崩溃问题确实需要处理，但不是上述 N-API 故障的相同复现。上述结论来自源码和发布记录，未对 MiLoCo 运行故障注入。

## 针对性验证入口

无需模型的生命周期与进程边界测试位于 `tests/perception/pool.test.ts`、`process.test.ts`、`process-ipc.test.ts` 和 `inference-pool.test.ts`；`annotation-output.test.ts` 核对接纳前超时、发布期间进程失效、提交结果未知时的容量和路径预约、跨池限制及关闭期限；`inference-queue.test.ts` 核对实际排队、重新入队和移除任务的计时；`detector.test.ts` 核对颜色、补边、边界框、连续坐标 NMS、取整输出和资源释放；`image.test.ts` 核对图片有界读取、哈希、解码、缩放、任务错误和完整 PNG 暂存；`report.test.ts` 核对报告不重新打开模型文件，以及基准漏投统计。真实模型集成测试另行显式传入本地资产，缺少环境变量时跳过：

```sh
ORT_DISABLE_TELEMETRY=1 PERCEPTION_MODEL_PATH=/path/to/det_4C.onnx bun test apps/backend/tests/perception/native-process.test.ts
```

真实模型测试覆盖独立 PID、图片完整链路与标注保存、父进程不加载原生图片/推理库、坏图片不重建模型、超时回收后的模型重载、计算子进程异常中止后调用方继续运行并重新检测，以及模型加载失败保留原因并释放进程名额。验证范围不等于保证所有平台和任意原生故障均可恢复。

检测效果由 `tests/perception/detection-quality.test.ts` 单独核对。使用 SHA-256 为 `c02019c4979c191eb739ddd944445ef408dad5679acab6fd520ef9d434bfbc63` 的 810×1080 公交车街景图片；模型与图片均由本地路径显式提供，不随测试下载或纳入仓库。测试中的两个完整人物区域按原图人工标注，不从模型输出生成；原图和缩小一半的图片均须检出这两个人，并与标注区域达到至少 0.5 的交并比（IoU，即框交集面积除以并集面积）。不固定置信度、总框数或边缘不完整人物的检出结果。

```sh
ORT_DISABLE_TELEMETRY=1 PERCEPTION_MODEL_PATH=/path/to/det_4C.onnx PERCEPTION_BUS_IMAGE_PATH=/path/to/bus.jpg bun test apps/backend/tests/perception/detection-quality.test.ts
```

缺少任一路径时该测试跳过；指定其他图片会因指纹不匹配失败。它验证人物检出和缩放后的坐标正确性，`native-process.test.ts` 同时检查纯色帧不产生目标。上述样本不代表家庭场景的检测准确率，尚无宠物、遮挡及真实无人房间的固定图片回归用例。

## 连续输入性能测量

```sh
bun run --cwd apps/backend benchmark:perception --seconds 20 /path/to/det_4C.onnx /path/to/image.jpg
```

基准在 macOS/Linux 上使用真实模型，以 `workload.kind = "image-file"` 标识文件任务，分别按 1080p／10 fps、4K／10 fps、4K／30 fps 提交路径与目标尺寸。每次任务都在子进程读取、计算哈希、按 `fill/lanczos3` 解码缩放并检测，父进程不持有预解码 RGB。每组预热 5 帧，输出一行 JSON；`--seconds` 设置每组持续时间（5–300 秒）。总耗时包含文件读取、哈希和解码，同一池跨三组复用。输入可换成实际摄像头截图，运行期间输入哈希变化会使基准失败。

比较报告时先核对输入模式和计时范围。文件任务的完整处理耗时，不能与预解码 RGB 帧的入队检测耗时直接比较，也不代表摄像头持续解码吞吐。

帧计划按单调时钟推进，统计 `planned`（计划帧数）、`offered`（实际提交帧数）和 `missedDueToEventLoop`（定时回调迟到而未提交的帧数）。回调迟到时只提交最新到期帧，不集中补发历史帧；`planned = offered + missedDueToEventLoop`。已提交任务中的队列满拒绝另计为 `busy`，不能与未提交帧或成功帧混为一类。检测延迟仅描述已接收且完成的任务，应同时查看漏投、拒绝和实际吞吐。

每行报告在 `metadata` 中统一记录模型路径、哈希、张量信息及实际执行后端，另含输入图片路径与哈希、CPU 型号、系统版本和运行环境、ORT/Piscina/sharp 版本、计算预算和输入限额，便于核对比较条件；系统未提供 CPU 型号时为 `null`。`scripts/perception-report.ts` 为图片命令和基准共用的报告入口，使用子进程提供的模型元信息，父进程只读取依赖版本和宿主环境。

报告还包括端到端、读取、解码、标注、模型三个阶段，以及排队、IPC 往返与线程分发各自的 p50/p95/p99/max、完成吞吐、10ms 主线程定时器的额外延迟，以及每 250ms 采样的父/子进程 RSS（操作系统统计的驻留内存）。基准未请求标注文件，`annotationMs` 为 0。RSS 报告为采样峰值，可能漏掉瞬时尖峰；主线程定时器延迟是响应性代理指标，不是 HTTP 响应时间。内存首尾四分之一均值帮助发现持续增长，不能单次据此断言泄漏。内存采样失败或非过载任务错误会让命令失败，不把缺失数据当零占用。

NMS 保持同类、按置信度排序的抑制规则，不为降低计算量截断候选或改变检测结果。用报告的 `postprocessMs` 判断该阶段是否值得进一步优化；固定图片短期测量不覆盖密集场景或全天摄像头稳定性。
