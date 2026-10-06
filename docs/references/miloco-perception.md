# MiLoCo 媒体感知与身份识别参考

本文记录 MiLoCo 如何筛选媒体、调用多模态模型、核验人宠身份、保存参考样本，以及感知事件进入 Agent 后的会话与上下文管理，供本项目核对参考行为与设计差异。MiLoCo 的登记成员身份判断主要由多模态 LLM（大语言模型）完成，本地检测、跟踪和状态机负责定位目标、组织候选及接纳结果；主模型请求频率与单个人物的身份重审频率是两个独立问题。

源码范围固定为 [XiaoMi/xiaomi-miloco 提交 `cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8`][mi-commit]。下文参数来自该提交的默认配置与实际分支，不代表某台机器的覆盖配置、实测请求率或识别准确率。引用路径相对于 MiLoCo 仓库；本机 checkout 位置由根目录 `AGENTS.local.md` 指定，不写入共享文档。本项目已实现能力见[本地感知](../perception.md)，待实施契约见[媒体计划](../plans/media-perception.md)，现有 Agent 数据交付的未验证范围见[Agent 通路验证边界](../household-runtime.md#agent-通路验证边界)。

## 实时媒体处理

```text
摄像头音视频 → 四秒媒体窗口 → 画面变化与声音能量筛选
                                    ├→ 未放行：跳过本窗下游处理
                                    └→ 本地检测与跟踪 → 本窗身份候选
                                                              ↓
                              多模态主请求：场景与声音理解，加上本轮需核验的身份
                                                              ↓
                                         本地身份状态机接纳结果与维护关联
```

默认每窗四秒，检测与跟踪输入为 3 fps（每秒帧数），送入多模态模型的视频为 1 fps、短边 512 像素。模型视频从已供跟踪使用的帧另行下采样，并保留窗口末帧，以对齐待识别目标的末帧位置。检测采样率、模型视频帧率与 HTTP 请求频率不能互相替代。

实时循环在窗口就绪或等待超时后处理输入，当前轮完成后继续处理已就绪窗口。多路摄像头分别筛选、分别发出主模型请求，设备之间并发；同一房间不会因此自动合成一次请求。模型延迟、窗口积压、丢弃与失败会影响实际处理节奏。

依据：[默认媒体配置][mi-settings]、[`InputConfig`][mi-config]、[实时循环][mi-runner]、[媒体主流程][mi-pipeline]。

## 媒体筛选与模型输入

画面变化、声音能量与 VAD（语音活动检测）在本地分别判断。声音能量决定是否分析声音，VAD 决定是否保留语音输出字段；未检出语音不等于没有犬吠等其他声音。默认声音能量阈值为 `0.015`，VAD 概率阈值为 `0.4`，窗口内至少三块过阈才判有人声。

| 窗口条件                                                   | 下游行为                                       |
| ---------------------------------------------------------- | ---------------------------------------------- |
| 检出视觉变化                                               | 放行视频分析，并独立判断是否携带音轨           |
| 未检出新变化，但仍在最近一次视觉变化后的 90 秒内且本窗有帧 | 通过 `hold` 持续放行视频分析                   |
| 视频未放行，但声音能量过阈                                 | 进入纯音频路由                                 |
| 视觉、声音能量和持续放行条件均未满足                       | 返回空筛选结果，跳过本窗检测、跟踪与主模型请求 |

90 秒从最近一次真实视觉变化开始计算；仅通过 `hold` 的静止窗口不续期，新的视觉变化会重新计时。缺少视频帧时，`hold` 不单独放行。因此这个参数表示变化后的持续观察时段，不是每 90 秒请求一次模型。

视频与纯音频路由共用 `model.omni` 配置，默认模型为 `xiaomi/mimo-v2.5`。默认 MiMo 适配中，视频经 `video_url` 提交 MP4，只有音频能量通过时才封装音轨；纯音频经 `input_audio` 提交 M4A，不携带视频、人物参考图或视觉身份候选。其他供应商适配自行转换输入形式，源码中的媒体构造不能证明每个模型端点都能正确理解该输入。

依据：[筛选实现][mi-gate]、[`GateConfig` 与 `OmniConfig`][mi-config]、[媒体与提示词构造][mi-prompt]。

## 主模型请求频率

默认 `omni_call_mode=fused`，表示把身份核验合并到本窗的场景与声音主请求中。身份派发器只缓存当前窗口的候选和参考资料，由 `run_omni_fused` 统一组织模型输入；单独识别调用的 `separate` 配置未实施，选择它会报错。

没有待识别人物时，`run_omni_fused` 使用空候选继续构造并发送主请求。身份重审节流只影响本轮是否附加人物身份问题，不会把场景请求降到同样的重审频率。视频连续放行、处理及时且默认窗口大小不变时，按 `60 ÷ 4` 推算，每路主请求约 15 次／分钟；这是配置推算，不能当作实测吞吐、严格请求上限或全部模型请求数。自动样本保存前的额外核验见下文。

依据：[模型请求入口][mi-omni]、[身份引擎装配][mi-engine]、[候选派发器][mi-dispatcher]。

## 人体身份核验与重审

默认采用 DeepSORT，即结合运动预测与人体外观特征进行局部跟踪。ReID（通过外观特征比较是否为同一个目标）用于跟踪关联、陌生人样本去重及身份漂移检查，轨迹编号和外观相似度不直接确认登记成员姓名。发生身份漂移时，本地规则可撤回关联并重新交给模型核验。

需要核验的轨迹携带末帧归一化位置、是否关联到人脸框等定位信息，模型对照登记成员的参考图片输出身份、未知或 `no_person`（检测框内并非真实人物）。当前目标此前的猜测姓名和已确认姓名不进入该目标的核验候选；其他已确认目标仍可作为场景名册。屏蔽旧猜测减少答案锚定，但不证明多次模型判断在统计上独立。

| 人物状态或条件                                  | 实际派发规则及默认参数                                       |
| ----------------------------------------------- | ------------------------------------------------------------ |
| 任意状态已有核验请求在途                        | 不重复派发                                                   |
| `pending`，身份尚未落定                         | 下一有效窗口继续派发；默认 60 秒仍未落定则转未知             |
| `confirmed`，通常状态                           | 名义重审间隔 30 秒                                           |
| `confirmed`，连续积累自动样本资格且尚未攒满     | 名义重审间隔 10 秒；未积累、攒满或在保存冷却期内均用慢间隔   |
| `confirmed`，正在累计看见人脸但否定原身份的结果 | 下一有效窗口继续核验，以取得纠正所需的下一次结果             |
| `unknown`，成员参考库非空                       | 首次重审使用常规间隔的一半，名义 15 秒；后续为 30 秒         |
| `unknown`，成员参考库为空                       | 使用代码默认的 600 秒慢重审间隔                              |
| 已落定 `no_person`                              | 通常停止派发；明显移动可重新进入核验，默认另有 1200 秒慢重审 |

这些名义秒数由 `needs_omni_call` 按 `engine_fps` 换算为帧编号差，在窗口处理中检查。媒体先要通过上游筛选，候选还须对应当前真正检出的目标；仅沿用预测框的轨迹不进入核验。因此不能把这些参数解释为独立墙钟定时器，或保证每隔相同秒数一定调用。

`dispatch.min_interval_sec=5.0` 虽然仍存在于默认配置，当前 fused 分支的 `needs_omni_call` 不使用它限频。`pending` 采用下一窗派发，不受这个五秒值保护。`max_queries_per_call=4` 在 `FusedDispatcher.dispatch` 中也只是超量告警，不截断候选，不能当作已执行的硬容量上限。

首次身份落定根据连续同答段的最高模型置信分数选择确认次数：高分阈值 `0.85` 对应一次，中分阈值 `0.65` 和低分阈值 `0.50` 对应三次；从已确认身份撤回后的重确认使用更严格的独立参数。模型自报分数和连续确认次数属于接纳规则，不能解释为识别准确率。

依据：[默认身份参数][mi-identity-defaults]、[身份派发与证据更新][mi-state]、[目标候选与漂移处理][mi-engine]、[身份输出要求][mi-fields]、[派发器的实际限额行为][mi-dispatcher]。

## 参考样本与额外模型请求

人体参考库区分用户登记的权威样本 `tier_a` 和按摄像头保存的自动样本 `tier_c`。模型请求中的参考集合由这些图片组织，不等于本地人脸向量匹配。展示身份的确认条件和自动保存样本的资格分开：确认后须连续六次重审一致，且满足其他图像与目标条件，才取得自动样本保存资格；成功保存后的名义冷却为 120 秒。

默认 `tier_c_verify_enabled=true`，且已注入模型配置时，保存前还会把待保存人体及人脸图片与该成员的 `tier_a` 参考交给模型做一次同人核验。只有 `same_person=true` 且分数至少 `0.8` 才通过；核验失败或未完成不保存。这个请求由独立低并发控制执行，不包含在“每窗一次主请求”的推算中。

默认自动样本在每日三点到五点的清理窗口内无条件清空，按日期和摄像头去重；不要求先确认无人。清理自动样本不等于删除用户登记参考，也不证明此前的身份判断正确。

依据：[样本默认策略][mi-identity-defaults]、[`_process_tier_c_candidate` 与 `_run_tier_c_verify`][mi-engine]、[参考图片组织][mi-library]。

## 宠物身份识别

`features.pet_recognition` 默认关闭。开启并有已登记宠物资料时，视频请求加入 `pet_identities`，让模型对照参考资料判断是否为某只登记宠物；只有物种或常见毛色相似不足以命名，无法确认时输出空列表。纯音频请求不产生视觉宠物身份判断。

默认本地轨迹只跟踪人体，猫狗检测框可参与其他媒体处理；宠物身份输出不复用人体 `TrackIdentityState` 的逐目标 10／30 秒重审机制。只要上述功能及资料条件满足，视频主请求就可以包含宠物身份问题。宠物参考图选择使用人体 ReID 特征时，它承担样本多样性筛选，不能当作已实现宠物专用个体识别模型。

依据：[宠物功能开关][mi-settings]、[人体跟踪默认范围][mi-identity-defaults]、[`PET_IDENTITIES` 与字段选择][mi-fields]。

## Agent 事件、会话与上下文管理

感知模型与办事 Agent 是两条上下文路径。感知模型每次重新组装本窗媒体、家庭档案、待判断规则及必要短期信息，不追加完整的历次模型对话；fused 请求中的只读历史目前仅用于尚未完成的跨窗语音，旧画面描述和旧建议不再注入。感知结果产生的交互、规则或建议再按各自条件进入 Agent 派发，不把所有窗口结果送入主聊天。依据：[感知消息组装][mi-prompt]、[事件生产与筛选][mi-perception-client]。

`AgentDispatcher` 按会话维护有界内存队列，批量取出同一类型的待发事件，再调用 Agent。建议在感知路径先抑制重复事件链并按紧迫度筛选；派发器另按优先级、容量与入队年龄淘汰。默认每会话最多 10 个待发项，待发消息有效期 300 秒；这些限制不约束已进入会话的历史或单个消息大小。停止时待发项被丢弃，不保证跨重启可靠交接。依据：[Agent 派发器][mi-agent-dispatcher]、[默认配置][mi-settings]。

| 输入 | OpenClaw 插件路径                 | Hermes 适配器路径                                 |
| ---- | --------------------------------- | ------------------------------------------------- |
| 交互 | 使用固定 `agent:main:miloco` 会话 | 按会话键与 lane（执行通路）映射稳定会话           |
| 规则 | 使用固定的独立规则会话            | 按会话键与 lane 映射稳定会话                      |
| 建议 | 使用固定的独立建议会话            | 每次派发生成新会话 ID，批内合并项在该次执行中评估 |

因此“每批事件都开新会话”不适用于全部路径；固定会话键也不证明底层完整历史永久驻留。插件管理的 OpenClaw 感知摘要、巡检等定时任务使用 `sessionTarget: isolated`（隔离会话）及轻量上下文，实际启用取决于调度管理配置。普通交互、规则与建议按提示词 profile（按执行角色选择的注入内容）加载材料，定时任务采用最小注入并自行读取所需资料。依据：[派发路由][mi-agent-dispatcher]、[Hermes 会话选择][mi-hermes-adapter]、[定时任务装配][mi-agent-scheduler]、[提示词注入][mi-agent-prompt]。

OpenClaw 插件预设每 15 分钟运行感知摘要，读取增量日志，由模型筛选有意义的活动、合并同段行为，追加到工作区每日 `memory/<date>-miloco-perception.md`。非最小 profile 每轮从文件读取今日摘要，今日无正文时读取昨日并标明日期；注入正文最多 2,000 字符，超限保留最近部分并提示 `memory_search` 查询更早材料。家庭档案通过 `home-profile list` 按需读取。这里既有模型摘要，也有确定性的近期截取与检索，不是纯粹的非压缩管理；2,000 字符仅约束感知记忆块，不约束会话总历史、系统提示词或设备清单。依据：[摘要技能][mi-agent-digest]、[调度装配][mi-agent-scheduler]、[注入与字符上限][mi-agent-prompt]。

巡检通过外部感知记忆和已处理台账接续，技能要求每轮先读取台账，处理后写回，以避免隔离会话重复提醒或操作。这是技能要求与模型行为，不能当作数据库级去重保证。固定会话仍可能增长；OpenClaw 插件检测到 `context overflow`（上下文溢出）后，尝试删除后台会话及 transcript（消息历史）并重建重试一次，主人实际 IM 会话不走该删除路径。宿主自身的压缩、裁剪和历史加载策略及实机效果需另行核对，插件代码不能证明固定会话永不溢出。依据：[巡检技能][mi-agent-patrol]、[溢出处理][mi-agent-webhook]。

这些机制说明 MiLoCo 采用“来源筛选与分流、部分固定会话、部分独立执行、外部摘要与按需读取”的混合方案，不证明存在一份长期装入全部家庭经历的主上下文。本项目已提供[Backend 数据送达 Agent](../household-runtime.md#agent-当前数据与材料历史)，模型上下文、证据保留和任务恢复另行设计，不由该参考推定为已采用机制。

## 与本项目的职责对齐

| 对齐项               | MiLoCo 参考行为                          | 本项目当前实现或现行计划                                                           |
| -------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| 本地检测与跟踪       | 实时主流程先筛选窗口，再运行检测与跟踪   | P1／P2 独立持续运行；P4 筛选不停止基础检测                                         |
| LLM 调用归属         | backend 感知主流程调用多模态模型         | 现行 P5／P6 计划由第一方 Agent 组织 LLM 请求，backend 负责媒体、小模型与确定性接纳 |
| 视觉变化后的持续放行 | 默认 90 秒，放行窗进入主模型请求         | 当前 P4 不保留变化后的静止窗口；计划中的有限观察与主动复核使用独立准入和预算       |
| 人物身份重审         | 状态机按窗口和名义间隔反复核验           | 现行 P6 要求身份问题与视觉质量筛选；到期本身不自动触发模型调用                     |
| 宠物身份             | 实验功能中的模型判断，本地默认不跟踪猫狗 | 已实现猫狗位置跟踪，个体身份尚未接入；人体 ReID 不确认某只宠物                     |
| 自动样本保存         | 连续确认、额外模型核验及定期清理         | 首期 P6 使用用户登记资料，自动样本积累另行定义资格与纠错                           |

本项目媒体来源扩展见[媒体计划](../plans/media-perception.md)，当前数据通路见[家庭运行时](../household-runtime.md#agent-当前数据与材料历史)；后续调用预算和采用参数另行确定。MiLoCo 采用 LLM 身份核验是它的实现选择，不构成本地身份识别在算法上必须依赖 LLM 的证明；本参考也不把讨论中的其他识别路线写成已采用能力。

[mi-commit]: https://github.com/XiaoMi/xiaomi-miloco/tree/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8
[mi-settings]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/config/settings.yaml
[mi-config]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/perception/engine/config.py
[mi-runner]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/perception/runner.py
[mi-pipeline]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/perception/engine/pipeline.py
[mi-gate]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/perception/engine/gate/gate.py
[mi-prompt]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/perception/engine/omni/prompt_builder.py
[mi-omni]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/perception/engine/omni/omni.py
[mi-engine]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/perception/engine/identity/engine.py
[mi-dispatcher]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/perception/engine/identity/dispatcher.py
[mi-identity-defaults]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/perception/engine/identity/default_config.yaml
[mi-state]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/perception/engine/identity/state.py
[mi-fields]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/perception/engine/omni/field_registry.py
[mi-library]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/perception/engine/identity/library.py
[mi-perception-client]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/perception/client.py
[mi-agent-dispatcher]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miloco/src/miloco/dispatch/dispatcher.py
[mi-hermes-adapter]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/plugins/hermes/miloco-plugin/hermes_adapter/adapter.py
[mi-agent-scheduler]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/plugins/openclaw/src/home-profile/scheduler.ts
[mi-agent-prompt]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/plugins/openclaw/src/hooks/prompt.ts
[mi-agent-digest]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/plugins/skills/miloco-perception-digest/SKILL.md
[mi-agent-patrol]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/plugins/skills/miloco-home-patrol/SKILL.md
[mi-agent-webhook]: https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/plugins/openclaw/src/webhooks/agent.ts
