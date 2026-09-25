# Step 1：统一米家接入目录与职责

[阶段入口](README.md) · [协议与源码参考](reference.md)

这是 Step 1 的目标组织方式，尚未实现。三个任务共同完成现有登录、设备目录、属性和视频的整合；目录调整不改变已经核实的小米协议，也不要求把两类凭据强行合成一种。

## 目标目录

```text
apps/backend/src/mijia/
├── routes.ts                       # 对外米家命令、查询与播放协商
├── service.ts                      # 唯一账号所有者与跨模块生命周期协调
├── errors.ts                       # 米家业务错误
├── operation.ts                    # 既有操作观测与错误映射
├── retry-timer.ts                  # 既有重试工具，按实际使用保留
├── account/
│   ├── login-flow.ts               # 登录尝试、取消、授权材料
│   └── session.ts                  # 凭据恢复／续期操作，提交归 service
├── devices/
│   ├── discovery.ts                # 唯一设备目录及刷新
│   └── mapping.ts                  # 设备业务映射、目录与规格组合
├── properties/
│   ├── reader.ts                   # 指定属性读取、批次预算与取消
│   └── source-profiles.ts          # 已验证通路与能力配置
├── media/
│   ├── session.ts                  # 视频绑定与媒体生命周期
│   ├── go2rtc-adapter.ts           # 现有 go2rtc 协议适配
│   ├── camera-source-spec.ts       # 单路摄像头源的描述类型
│   ├── camera-source-manager.ts    # 共享源创建、更新与回收
│   └── playback-manager.ts         # 播放预约、协商与释放
└── protocols/
    ├── micloud/                    # 现有扫码、cookie、目录及规格协议实现
    └── miot/
        ├── oauth.ts                # MiLoCo OAuth、身份映射与 token 交换
        ├── http-client.ts          # OAuth HTTP 编码及属性请求
        └── mqtt.ts                 # MQTT 连接、订阅对账与消息解码
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

新增 properties/reader.ts 负责指定属性读取的批次、预算及取消，source-profiles.ts 负责来源能力配置；不命名为含义不明的 access.ts，也不把 reader 做成通用调度器。MIoT 下 oauth.ts、http-client.ts、mqtt.ts 分别对应授权、HTTP 客户端和 MQTT 连接；参考源码中的 mips_cloud.py 名称保持原样。

account 表达账号及授权生命周期；properties 表达设备属性；media 包括共享摄像头源与浏览器播放；protocols 区分外部协议与业务职责。它们无需再改名。routes.ts、service.ts、errors.ts、operation.ts、retry-timer.ts 沿用现有具体职责；不增加 manager、utils、common 等无明确用途的目录。

## 所有权与依赖

| 模块       | 负责什么                                                   | 如何协作                                                                                               |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| service    | 稳定账号身份、凭据接纳、保存、换账号、退出、启动与停止顺序 | 沿用现有协调能力，调用 account、devices、properties、media；不新增第二个账号管理器                     |
| account    | 扫码／OAuth 授权流程、凭据恢复和续期操作                   | 两类凭据按用途保存，经 uid／区域核验绑定同一账号；结果交 service 提交，协议客户端不自行持久化或切账号  |
| devices    | 设备、家庭／房间、规格的统一读取入口                       | 当前沿用 MiCloud 目录与规格实现；向属性和媒体提供同一设备身份与合法设备集，不另建 OAuth／MQTT 设备目录 |
| properties | 指定属性读取与观测输出；不选择缺值或待确认项               | 使用同一账号与目录；调用 MIoT HTTP／MQTT，不拥有家庭 latest 或规则状态                                 |
| media      | go2rtc 绑定、摄像头源及播放资源                            | 使用同一账号与目录，通过 service 接受凭据更新和撤销，不直接启动另一套米家登录                          |
| protocols  | 小米具体请求编码、响应解码及连接协议                       | 不依赖 routes、service、家庭 actor；不保存另一份业务目录或公开家庭状态                                 |

service 负责装配与跨模块通知，子模块通过具体参数／回调接收所需依赖，避免互相导入 service 实例。协议错误在业务边界映射；HTTP 路由只做请求校验和调用，不直接创建小米客户端或拥有后台任务。

目录唯一指业务目录只有一个所有者；媒体持有的活动摄像头资源、MQTT 的订阅集合是各自派生状态，不能反过来成为独立设备目录。Step 2 接管目录到家庭 actor 时，同批替换其业务状态来源，不保留两份可独立更新的目录。

## 接口、授权与失败范围

- 前端通过同一组米家业务接口完成登录、设备读取、属性读取与播放；共享业务类型仍在 `packages/api/src/contracts/`，页面仍在 `apps/web/src/features/mijia/`。不按扫码／OAuth 再复制一套设备页、播放器或 API 命名空间。
- 账号身份统一，授权能力分开表达：扫码／目录、OAuth、属性订阅、媒体各有实际状态。“扫码成功”“MQTT 已连接”“视频能播放”不能互相代替。
- 当前 go2rtc 使用 userId/passToken/region；属性 HTTP／MQTT 使用 OAuth。两套协议凭据是不同能力的依赖，不是新旧兼容路径，不承诺一次 OAuth 自动获得视频授权。
- OAuth 失败只停止依赖它的属性通路，go2rtc 故障只影响媒体；任一凭据失败不得自动转用另一协议兜底。账号整体退出或身份更换时，统一撤销两类凭据、目录、读取、订阅与播放；同账号凭据续期只更新依赖它的资源。
- 移动模块或调整业务契约时，同批更新所有实际调用方、共享类型及当前文档；删除原路径，不保留转发导出、兼容别名、双写或备用实现。仅目录迁移不要求无故改变 HTTP URL。

Step 1 的设备范围由操作者显式选择、service 按现有账号目录核验，正式内部调用与验收见 [共同参考](reference.md#step-1-的调用范围与验收入口)。Step 2 的家庭选择、Step 3 的 latest／availability／版本仲裁均不是本阶段输入；properties/reader.ts 不持有这些状态。

## 三个任务的迁移安排

| 任务 | 目录与集成交付                                                                                                                        | 本次必须验证的已有功能                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1.1  | 迁移现有 account、devices、media、micloud 模块并更新导入；统一账号／目录所有权；新增 miot/oauth、http-client 和 properties 的读取职责 | 扫码登录、目录／规格读取、摄像头播放与释放仍正常；新增 OAuth 与属性读取可用        |
| 1.2  | 在同一账号与目录下增加 miot/mqtt，复用 properties 的输出与来源配置                                                                    | MQTT 不另拉一套目录、不影响已有视频；订阅撤销遵循账号生命周期                      |
| 1.3  | 完成 service 的连接恢复及联合生命周期接线，不另加通用协调框架                                                                         | 重启恢复、两类凭据续期、局部故障、退出与换账号覆盖目录、属性及视频，旧任务不串账号 |

1.1 先把现有已运行模块搬到最终位置，后续任务在原位扩展。各任务交付均为最终实现的一部分；不把 XState、SSE、家庭状态仲裁或历史库提前纳入 Step 1，也不把现有视频接入的正确性推迟到 Step 5。
