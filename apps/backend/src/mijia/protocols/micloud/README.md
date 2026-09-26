# MiCloud adapter

本模块将 [homebridge-miot](https://github.com/merdok/homebridge-miot) 的独立 MiCloud 协议代码移植为 Bun TypeScript 模块，提供米家二维码登录、短信／邮件安全验证、授权会话导出与恢复、passToken 会话续期，以及设备清单和属性的加密读取请求。设备清单包含家庭、房间、设备及其归属。会话保存、凭据加密和续期调度由 backend 负责；本模块不包含 Homebridge、设备控制、密码登录或 OAuth。

## 固定来源与许可

上游固定 commit：`8d27204423a569e11c468830e3df324d278954ee`。

| 移植来源                                                                                                                                             | 本地模块                    | 上游文件 SHA-256                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------ |
| [`lib/protocol/MiCloud.js`](https://github.com/merdok/homebridge-miot/blob/8d27204423a569e11c468830e3df324d278954ee/lib/protocol/MiCloud.js)         | `client.ts`、`transport.ts` | `a27a12b3051e20860afa7f3986cb5fac87d19e0609aaae5db1521e5b6e10c997` |
| [`lib/utils/CustomCryptRC4.js`](https://github.com/merdok/homebridge-miot/blob/8d27204423a569e11c468830e3df324d278954ee/lib/utils/CustomCryptRC4.js) | `rc4.ts`                    | `f0c553bce61aff761b344c8647f4334d8d59569aa71074b3f3e3ac137cf56baf` |

上游 MIT 许可全文保留在 [LICENSE](LICENSE)，版权为 Copyright (c) 2025 Marcin。RC4 模块原有的 edomi-roboroc 来源说明保留在代码中。

passToken 续期遵循仓库固定版本 [go2rtc `LoginWithToken`](https://github.com/AlexxIT/go2rtc/blob/b5948cfb25404cc5cb37b166ecaa2dca20b11d4b/pkg/xiaomi/cloud.go#L345) 的同一米家账号协议：向 `account.xiaomi.com/pass/serviceLogin` 提交限定该主机及 `/pass` 路径的 `userId`／`passToken` Cookie，取得 `ssecurity` 和 STS 地址，再完成设备会话。该协议与 OAuth refresh token 无关；go2rtc 来源和 MIT 许可见 [构建目录](../../../../../../docker/go2rtc/README.md)。

`node-fetch` 替换为 Bun 原生 `fetch`、`Headers.getSetCookie()` 和 `AbortSignal`；`randomstring` 替换为 `node:crypto`；`querystring` 替换为 `URLSearchParams`。[`tough-cookie` 6.0.2](https://github.com/salesforce/tough-cookie/releases/tag/v6.0.2) 的内存 `CookieJar` 负责 Cookie 解析、域名／路径匹配、过期、删除和同名 Cookie 排序。收到 `Max-Age` 时，使用库的 `expiryTime()` 计算并保存绝对过期时间，避免读取 Cookie 更新访问时间而延长寿命。Bun 版本沿用仓库 `packageManager` 和 `engines`。

`client.ts` 管理扫码、安全验证、会话和设备加密协议；`session.ts` 定义可导出授权的校验结构；`transport.ts` 持有 CookieJar 和请求生命周期。传输层逐跳校验目标仅为小米可信 HTTPS 地址，并按目标 URL 匹配 Cookie；凭据读取限定当前验证／STS 响应 URL。重定向遵循 Fetch 语义：301／302 将 POST 转为 GET，303 将非 GET／HEAD 转为 GET，307／308 保留方法及可重放的表单请求体；跨源跳转移除 Authorization。验证码提交额外拒绝一切跨 origin 重定向，不能把验证码请求体重放到其他主机。各跳及最终响应体读取共享一次超时与取消信号，错误分类以组合信号的首次中止原因为准，响应体限制为 4 MiB；`extension-pragma` 中的登录材料在每次跳转前交回账号协议处理。返回业务层时响应体已读取并释放。

## 摄像头通道能力

`camera-capabilities.json` 保存从小米官方 MiLoCo 的 [`camera_extra_info.yaml`](https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miot/src/miot/configs/camera_extra_info.yaml) 抽取的通道数量事实，包含上游版本、路径和原文件 SHA-256。该版本声明 7 款双摄；未列入额外能力表的摄像头采用单通道，与同版本 `MIoTClient.get_cameras_async` 的规则一致。运行时不请求 GitHub，也不按型号名称包含“dual”等字样猜测镜头数。更新这份通道能力表时应从固定上游重新抽取并同步来源信息，不在业务或 Go 代码中添加型号分支。

这里只提取通道数量，没有照搬 MiLoCo 原生摄像头 SDK 的设备白名单和黑名单；本项目的取流协议支持范围仍由 go2rtc 决定。

`camera-count` 是 MIoT `camera-control` 服务的可选属性，并非所有双摄都提供；已核对的 7 款中有 6 款公开规格未声明它。`audio-channel` 表示声道数，不能用于判断镜头数。因此当前通道清单使用官方能力表，不宣称能自动识别表中未列出的所有新双摄。通道能力声明也不等同于所有型号的媒体协议已实机通过。

后台将通道能力作为 `channelCount` 传给媒体适配器。当前媒体实现支持 1／2 个镜头；更大的声明不会被截断成两路。双摄使用 MISS 的 `videoquality`／`videoquality2` 联合启动、`flags` 高字节分流，默认画质沿用 go2rtc 既有规则。实机回归范围仍是本地 C500 双摄与 C700 单摄，其他型号保持能力识别与实际播放证据分开记录。

## 生命周期

这里的会话是米家云账号／设备请求会话；go2rtc 的 `sessionId` 和心跳租约属于独立的媒体运行时资源，见[资源定义](../../../../../../docs/mijia.md#组件与资源)。

每次扫码创建独立的 `new MiCloud({ region: "cn" })`。`createLogin()` 返回二维码图片数据、毫秒过期时间及轮询间隔，长轮询地址仅保留在实例内部。`pollLogin()` 持有该次登录的 cookie、设备标识与加密材料；登录完成时必须获得 `ssecurity`、`userId`、`serviceToken`、`passToken`。缺少任意材料均报告 `missing-credentials`。

若小米返回 `notificationUrl`，状态为 `security-required`。用户打开小米安全验证页面请求短信或邮件验证码，再通过 `submitSecurityCode()` 提交收到的数字验证码。验证码通过同次登录的 cookie 会话提交至小米验证接口；账号 token 不需要用户搬运。仅支持上游的 `authStart` 页面及电话／邮件验证类型，其他验证类型报告 `unsupported-security`。安全验证仍受原二维码过期时间约束。

`getCatalog()` 通过 `getHomes()` 查询 `/v2/homeroom/gethome` 与归属分页 `/v2/homeroom/get_dev_room_page`，汇总自有及共享家庭、房间中的设备 ID，再分批调用 `/v2/home/device_list_page` 获取设备详情。每批最多 150 个 ID，并检查详情分页游标，按设备 ID 去重，只接纳本批请求的设备；清单为空时不发送设备详情请求。协议参数参考[小米官方集成](https://github.com/XiaoMi/ha_xiaomi_home/blob/main/custom_components/xiaomi_home/miot/miot_cloud.py)的设备详情读取，沿用现有 RC4 会话。详情接口返回的 `localip` 原样保留，供摄像头局域网连接使用。设备详情与家庭清单请求使用同一 RC4 签名传输，未找到归属时返回空值，不推测安装位置。`homes.ts` 负责设备清单响应校验、分页和归属映射。

`getProperties()` 通过同一已登录 MiCloud 实例的 RC4 请求调用 `/miotspec/prop/get`，沿用当前 userId、serviceToken、ssecurity 和 Cookie。它复用既有扫码会话，不发起额外 OAuth 或另存属性授权。`datasource=1` 为缓存优先，缺失时可能触发设备 RPC，不保证最新值；批次调度、readable 规格预检、取消与逐项观测由业务 `properties/` 模块负责，完整语义见[米家来源契约](../../../../../../docs/reference/mijia-source-contract.md)。

公开设备规格由独立的 [`spec/`](../spec/README.md) 协议客户端读取，不使用本模块的账号会话。

`getCredentials()` 明确包含上游会话导出遗漏的 `passToken`，供 backend 比较续期前后的凭据，并通过 `Go2RtcAdapter` 将凭据安装到 go2rtc 运行时会话。设备与摄像头统一使用中国大陆区域 `cn`；其他区域被拒绝。

登录完成后清理账号登录 Cookie，只保留限于设备 API 主机和 `/app` 路径的协议 Cookie。STS 的 `serviceToken` 与设备协议要求的 `yetAnotherServiceToken` 使用相同的绝对过期时间；设备会话不会把登录 `passToken` 发送到设备 API。

`exportSession()` 返回 backend 专用的 `MiCloudSavedSession`，包含同次授权凭据、设备请求标识及 STS serviceToken Cookie 的绝对到期时间；上游未给到期时间时保存 `null`，不推测协议有效期。`MiCloud.restoreSession(value)` 校验导入结构并重建受限 Cookie，保留到期会话的 passToken 供续期；它不恢复二维码或验证码流程，过期 serviceToken 不能用于设备请求。

`renewSession(signal)` 使用独立实例和 CookieJar 完成 token 交换，检查用户身份一致，并返回等待调用方验证、保存后采用的新会话；失败、取消和新实例释放均不影响当前会话。调用者负责同一账号只执行一个续期任务、验证新会话能发起设备请求、保存成功后再采用，以及销毁未被采用的实例。backend 在恢复授权时先续期；运行中按已知到期时间提前最多 5 分钟续期，剩余时间较短时取其一半。无到期时间时每 6 小时主动重新验证，这是本应用策略而非小米承诺的有效期。网络失败保留旧凭据并退避重试；明确拒绝 passToken 或再次要求安全验证时重新扫码，协议或存储错误需显式重试。passToken 未轮换且媒体仍就绪时，采用新设备会话不重建摄像头流。

导出数据和续期返回的新会话均包含凭据，不能进入浏览器、普通配置、日志或追踪。真实账号的持续续期仍需实机验收。

`dispose()` 中止在途请求并清理 cookie、扫码状态及凭据。所有异步登录结果在写入会话前检查取消状态与二维码期限；调用者仍须检查当前业务会话身份，以避免已经完成的旧请求提交到新的绑定流程。过期或取消后必须创建新实例。

原始设备数据只在 backend 内部使用，返回浏览器前只保留允许公开的字段。本模块不提供 logger，不记录请求、响应、cookie、URL、二维码或验证码；所有错误均为静态 `MiCloudError.code`，不包含上游消息或底层异常 cause。调用者的日志和追踪同样不得记录本模块参数、返回值或实例。

真实扫码、安全验证与具体摄像头型号兼容性需要在实际账号和设备上验收；编译通过不代表已经完成实机验证。

`getProfile()` 使用当前会话的用户 ID 读取 `https://api.account.xiaomi.com/pass/usersCard`，校验返回用户身份，将 `miliaoNick` 和 `miliaoIcon` 转换为昵称和 HTTPS 头像地址。请求限时 10 秒，并随客户端释放取消；不需要额外 OAuth 授权。
