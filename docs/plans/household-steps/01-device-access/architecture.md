# Step 1：米家接入目录与职责

[阶段入口](README.md) · [协议与源码参考](reference.md)

现有扫码流程是唯一用户登录入口。`service.ts` 持有已接纳账号与跨模块生命周期；MiCloud 请求、后端 OAuth 授权、MQTT 和媒体是该账号的不同接入通路。

## 当前目录

```text
apps/backend/src/mijia/
├── routes.ts                       # HTTP 请求校验、业务调用与播放协商
├── service.ts                      # 账号接纳、持久化及跨模块生命周期
├── errors.ts                       # 米家业务错误
├── operation.ts                    # 操作观测与错误映射
├── retry-timer.ts                  # 可取消、可分段的重试计时
├── account/
│   ├── login-flow.ts               # 扫码尝试、取消与授权候选
│   ├── maintenance.ts              # 账号恢复／续期任务及计时器
│   └── session.ts                  # 候选会话准备
├── homes/
│   └── store.ts                    # 账号对应的家庭选择持久化
├── devices/
│   ├── discovery.ts                # 云端目录发现、访问范围与派生索引
│   ├── directory-notifications.ts  # 账号级目录通知及刷新防抖
│   └── mapping.ts                  # 展示字段与摄像头通道映射
├── properties/
│   ├── read-request.ts             # 输入复制、设备分组与 readable 预检
│   ├── reader.ts                   # 属性批次、全局串行预算及取消
│   ├── observation.ts              # 活动观察、重连与凭据更新接线
│   └── source-profiles.ts          # 来源身份、能力条件与证据配置
├── media/
│   ├── session.ts                  # 账号媒体绑定及生命周期
│   ├── go2rtc-adapter.ts            # go2rtc 请求及资源适配
│   ├── camera-source-spec.ts       # 摄像头源输入边界
│   ├── camera-source-manager.ts    # 共享摄像头源创建与回收
│   └── playback-manager.ts         # 观看预约、协商与释放
└── protocols/
    ├── micloud/                    # 扫码、Cookie、目录、规格与 RC4 属性请求
    │   └── properties.ts           # MIoT 属性地址及应用读取预算
    ├── oauth/
    │   └── client.ts               # 后端 OAuth 授权、token 交换与刷新
    └── miot/
        ├── mqtt.ts                 # 单代 MQTT 连接及订阅对账
        └── messages.ts             # topic 校验与消息规范化
```

目录说明业务范围，文件说明具体职责。`micloud/` 保留协议实现所需的内部命名、README 和 LICENSE。没有迁移转发导出、兼容别名、双写或备用实现；不为未接入能力创建空类或通用 provider 层。

`apps/backend/src/household/` 持有已提交家庭目录、规格及公共状态，供应商 discovery 保留请求、原始接入资料和访问索引。家庭运行时、持久化及 SSE 的模块职责见[家庭运行时](../../../household.md)。

## 所有权与依赖

| 模块       | 所有权与职责                                               | 协作边界                                                                 |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| service    | 稳定账号身份、凭据接纳、保存、家庭选择提交、退出和停止顺序 | 调用 account、devices、properties、media；通过同一提交队列保存及接纳候选 |
| account    | 扫码、恢复／续期操作与计时器                               | 只准备候选和维护任务状态，由 service 提交账号                            |
| homes      | 家庭选择的存储适配                                         | 不另建家庭设备目录，service 负责业务选择和提交                           |
| devices    | 云端目录发现、访问索引及目录通知                           | 完整候选交家庭模块保存和提交，确认撤销时先取消设备访问                   |
| household  | 已提交家庭目录、规格、作用域和公共状态                     | 通过 service 协调供应商接入，向 Web 提供同一已提交状态                   |
| properties | 指定属性读取、活动观察和规范化输出                         | 使用同一账号与目录，不拥有家庭 latest、规则或缺值状态                    |
| media      | go2rtc 绑定、共享源及播放资源                              | 经 service 接受凭据更新和撤销，不独立登录                                |
| protocols  | 小米请求编码、响应解码及连接协议                           | 不依赖 routes/service/家庭 actor，不持久化账号或另建业务目录             |

子模块通过具体参数、实例或回调接收所需依赖，不互相导入 service 实例。账号候选的持久化与接纳通过 service 的同一提交队列完成。属性预检读取家庭模块已准备的规格，账号、读取代次和设备归属仍由 service 核验。协议错误在业务边界映射；HTTP 路由只校验请求和调用业务，不创建小米客户端或后台任务。共享业务契约位于 `packages/api/src/contracts/`，HTTP 读取上限等跨应用基础能力复用 `packages/api/src/http/`。

设备目录仅有一个业务所有者。媒体的活动摄像头资源和 MQTT 的订阅集合是派生状态，不能反过来成为独立目录。读取取消范围、观察范围和单次连接代次分别表达真实生命周期，不能仅凭一次连接健康状态证明每项能力有效。

## 查询、预算与取消

`readProperties(properties, signal)` 和 `observeDevices(deviceIds, onObservation, signal)` 是正式内部入口，不增加属性专用授权页或 HTTP API。service 校验账号、现有家庭选择及设备归属；异步交付重验活动范围，旧实例结果不得进入新范围。

`properties/read-request.ts` 按设备分组，同步校验家庭模块已准备的 readable 规格；`reader.ts` 管理全服务串行属性批次。`household/specifications.ts` 按活动 model／URN 分组共享规格，最多三组并发准备，移除设备或撤销家庭时取消不再引用的任务。协议客户端只获取和解析公开元数据，同一客户端内相同在途请求合并；每位调用者保留自己的取消信号及 30 秒预算，最后一位等待者取消才中止共享传输。展示翻译失败不抹掉已经取得的能力规格。

## 授权与失败范围

- 目录与属性 HTTP 使用 MiCloud Cookie、serviceToken、ssecurity 及 RC4；媒体从同一账号取得 userId/passToken/region；MQTT 使用同账号统一保存的 OAuth access token 和实例 UUID。
- 后端 OAuth 是扫码登录的组成部分，不是第二个用户登录入口。HTTP 读取、MQTT 连接、订阅确认、实际收包与视频出帧分别验证。
- 属性、MQTT 与 go2rtc 的局部失败只影响对应通路，不自动切换协议。账号退出、身份更换及家庭范围撤销统一使相关资源失效。
- 同账号 MiCloud 会话续期取消旧读取，但保留稳定来源身份及有效观察；OAuth token 更新时重建 MQTT 并重新确认活动订阅。
- 共享来源配置不记录真实账号／设备 ID 或凭据。具体已验证条件和限制见[来源契约](../../../mijia-source-contract.md)。

## 后续架构边界

Step 2 已接管家庭目录、规格和公共状态订阅。Step 3 计划负责自动采集集合、上线补缺、重连补读、latest／availability 及属性版本仲裁，复用现有读取与观察入口，不再创建另一套协议客户端。
