# Step 1：统一米家接入目录与职责

[阶段入口](README.md) · [协议与源码参考](reference.md)

整个接入层遵守[账号接入前提](README.md#账号接入前提)：现有米家扫码流程是唯一用户登录入口，账号保存、恢复、续期和退出由同一所有者管理，不新增独立 OAuth、额外授权页面或第二套 token 仓库。任务 1.1 通过同一 MiCloud 会话读取目录、规格和指定属性，service 统一协调媒体。实机结论以来源契约和任务报告为准。MQTT 由 `protocols/miot/mqtt.ts` 实现，service 提供 `observeDevices`，`properties/observation.ts` 持有活动观察与重连计时器。

## 目标目录

```text
apps/backend/src/mijia/
├── routes.ts                       # 对外米家命令、查询与播放协商
├── service.ts                      # 唯一账号所有者与跨模块生命周期协调
├── errors.ts                       # 米家业务错误
├── operation.ts                    # 既有操作观测与错误映射
├── retry-timer.ts                  # 既有重试工具，按实际使用保留
├── account/
│   ├── login-flow.ts               # 扫码登录尝试、取消、授权材料
│   ├── maintenance.ts              # MiCloud 恢复续期任务及计时器
│   └── session.ts                  # MiCloud 会话恢复／续期候选准备，提交归 service
├── devices/
│   ├── discovery.ts                # 唯一设备目录及刷新
│   └── mapping.ts                  # 设备展示与摄像头通道映射
├── properties/
│   ├── read-request.ts             # 请求复制、按设备分组与 readable 规格预检
│   ├── reader.ts                   # 指定属性读取、批次预算与取消
│   ├── observation.ts              # 活动观察、退避重连与凭据更新接线
│   └── source-profiles.ts          # 已验证通路与能力配置
├── media/
│   ├── session.ts                  # 视频绑定与媒体生命周期
│   ├── go2rtc-adapter.ts           # 现有 go2rtc 协议适配
│   ├── camera-source-spec.ts       # 单路摄像头源的描述类型
│   ├── camera-source-manager.ts    # 共享源创建、更新与回收
│   └── playback-manager.ts         # 播放预约、协商与释放
└── protocols/
    ├── micloud/                    # 扫码、Cookie、目录、规格和 RC4 属性请求
    │   └── properties.ts           # MIoT 属性地址类型及应用读取预算
    └── miot/
        ├── mqtt.ts                 # MQTT 连接、订阅对账与取消
        └── messages.ts             # topic 校验与消息规范化
```

按下表迁移并统一命名；`micloud/` 连同其 LICENSE、README 及内部依赖整体迁入。新增文件在对应能力实施时创建，不提前铺空目录、空类或统一 provider 框架。`properties/reader.ts` 承担实际批量读取与取消职责，不只是转发 HTTP 的包装层。

## 文件命名与迁移

路径均相对于 apps/backend/src/mijia/。目录说明业务范围，文件说明具体职责；同一目录内不重复前缀，也不靠单复数区分类型与资源管理器。

| 现有文件            | 实施后的唯一位置                                 |
| ------------------- | ------------------------------------------------ |
| login-flow.ts       | account/login-flow.ts                            |
| account-session.ts  | account/session.ts                               |
| device-discovery.ts | devices/discovery.ts                             |
| devices.ts          | devices/mapping.ts                               |
| media-session.ts    | media/session.ts                                 |
| camera-source.ts    | media/camera-source-spec.ts                      |
| camera-sources.ts   | media/camera-source-manager.ts                   |
| go2rtc-adapter.ts   | media/go2rtc-adapter.ts                          |
| playback-manager.ts | media/playback-manager.ts                        |
| micloud/            | protocols/micloud/，保留其内部文件命名及许可材料 |

household/ 持有已提交家庭目录与规格，供应商 discovery 保留请求和原始媒体接入资料。properties/read-request.ts 按设备分组预检 readable 规格，reader.ts 负责指定属性读取的批次、预算及取消，source-profiles.ts 负责来源能力配置；不命名为含义不明的 access.ts，也不把 reader 做成通用调度器。属性请求由 micloud/client.ts 复用扫码实例发出；地址类型和应用预算位于 micloud/properties.ts。MQTT 由 miot/mqtt.ts 承担；参考源码中的 mips_cloud.py 名称保持原样。

account 表达账号及授权生命周期；properties 表达设备属性；media 包括共享摄像头源与浏览器播放；protocols 区分外部协议与业务职责。它们无需再改名。routes.ts、service.ts、errors.ts、operation.ts、retry-timer.ts 沿用现有具体职责；不增加 manager、utils、common 等无明确用途的目录。

## 所有权与依赖

| 模块       | 负责什么                                                   | 如何协作                                                                                                 |
| ---------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| service    | 稳定账号身份、凭据接纳、保存、换账号、退出、启动与停止顺序 | 沿用现有协调能力，调用 account、devices、properties、media；不新增第二个账号管理器                       |
| account    | 扫码授权流程、MiCloud 会话恢复和续期操作                   | 准备同一 MiCloud 账号的候选会话；结果交 service 提交，协议客户端不自行持久化或切账号                     |
| devices    | 设备、家庭／房间、规格的统一读取入口                       | 当前沿用 MiCloud 目录与规格实现；向属性和媒体提供同一设备身份与合法设备集，不另建属性读取／MQTT 设备目录 |
| properties | 指定属性读取与观测输出；不选择缺值或待确认项               | 使用同一账号与目录；通过当前 MiCloud 实例读取，通过已接入的 MQTT 交付观察，不拥有家庭 latest 或规则状态  |
| media      | go2rtc 绑定、摄像头源及播放资源                            | 使用同一账号与目录，通过 service 接受凭据更新和撤销，不直接启动另一套米家登录                            |
| protocols  | 小米具体请求编码、响应解码及连接协议                       | 不依赖 routes、service、家庭 actor；不保存另一份业务目录或公开家庭状态                                   |

service 负责装配与跨模块通知，子模块通过具体参数／回调接收所需依赖，避免互相导入 service 实例。account 的流程模块只持有操作状态、任务、计时器和候选工作；MiCloud 恢复续期归 maintenance。当前账号、已接纳 MiCloud 会话及读取采集代次归 service，持久化与接纳通过同一提交队列完成。属性规格预检通过家庭运行时的已准备规格和有效性断言回调读取资料，账号、采集实例和设备归属的有效性仍由 service 核验。协议错误在业务边界映射；HTTP 路由只做请求校验和调用，不直接创建小米客户端或拥有后台任务。

目录唯一指业务目录只有一个所有者；媒体持有的活动摄像头资源、MQTT 的订阅集合是各自派生状态，不能反过来成为独立设备目录。Step 2 接管目录到家庭 actor 时，同批替换其业务状态来源，不保留两份可独立更新的目录。

## 接口、授权与失败范围

- 前端通过同一组米家业务接口完成登录、设备查询与播放；属性读取由同一 service 的正式内部入口提供；共享业务类型仍在 `packages/api/src/contracts/`，页面仍在 `apps/web/src/features/mijia/`。不新增属性读取专用授权页或另一套设备 API 命名空间。
- 账号身份和读取会话统一；扫码／目录、属性读取、属性订阅和媒体各有实际结果。“扫码成功”“MQTT 已连接”“视频能播放”不能互相代替。
- 当前 go2rtc 使用扫码账号的 userId/passToken/region；目录与属性 HTTP 复用该 MiCloud 实例的 Cookie、serviceToken、ssecurity 及 RC4 编码。MQTT 须在复用已有登录流程的前提下核实鉴权；HTTP 读取成功不证明推送可用。无法在此前提下接入时记录该能力限制，不增加 OAuth 或备用登录通路。
- 属性传输故障只报告对应读取失败，go2rtc 故障只影响媒体；不自动转用另一协议。账号整体退出或身份更换时，统一撤销会话、目录、读取、订阅与播放。MiCloud 会话续期替换实例时，旧读取取消；同账号续期不改变稳定来源身份。
- 移动模块或调整业务契约时，同批更新所有实际调用方、共享类型及当前文档；删除原路径，不保留转发导出、兼容别名、双写或备用实现。仅目录迁移不要求无故改变 HTTP URL。

Step 1 的设备范围由操作者显式选择或授权代理选择、service 按现有账号目录核验，正式内部调用与验收见 [共同参考](reference.md#step-1-的调用范围与验收入口)。Step 2 的家庭选择、Step 3 的 latest／availability／版本仲裁均不是本阶段输入；properties/reader.ts 不持有这些状态。

## 三个任务的迁移安排

| 任务 | 目录与集成交付                                                                                                                    | 本次必须验证的已有功能                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1.1  | 迁移现有 account、devices、media、micloud 模块并更新导入；统一账号／目录所有权；复用 micloud 属性请求并交付 properties 的读取职责 | 扫码登录、目录／规格读取、摄像头播放与释放仍正常；同一扫码会话的属性读取可用 |
| 1.2  | 在同一账号与目录下增加 miot/mqtt，复用 properties 的输出与来源配置                                                                | MQTT 不另拉一套目录、不影响已有视频；订阅撤销遵循账号生命周期                |
| 1.3  | 活动观察持有唯一退避计时器，每次连接获取当前账号凭据                                                                              | 断线重连、活动订阅恢复与取消停止重试；联合生命周期验收不在最小范围内         |

1.1 先把现有已运行模块搬到最终位置，后续任务在原位扩展。各任务交付均为最终实现的一部分；不把 XState、SSE、家庭状态仲裁或历史库提前纳入 Step 1，也不把现有视频接入的正确性推迟到 Step 5。
