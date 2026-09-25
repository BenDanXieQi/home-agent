# MiCloud adapter

本模块将 [homebridge-miot](https://github.com/merdok/homebridge-miot) 的独立 MiCloud 协议代码移植为 Bun TypeScript 模块，提供米家二维码登录、短信／邮件安全验证、授权会话导出与恢复、passToken 会话续期及加密设备列表请求。会话落盘、加密和续期调度由 backend 负责；本模块不包含 Homebridge、设备控制、密码登录或 OAuth。

## 固定来源与许可

上游固定 commit：`8d27204423a569e11c468830e3df324d278954ee`。

| 移植来源                                                                                                                                             | 本地模块                    | 上游文件 SHA-256                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------ |
| [`lib/protocol/MiCloud.js`](https://github.com/merdok/homebridge-miot/blob/8d27204423a569e11c468830e3df324d278954ee/lib/protocol/MiCloud.js)         | `client.ts`、`transport.ts` | `a27a12b3051e20860afa7f3986cb5fac87d19e0609aaae5db1521e5b6e10c997` |
| [`lib/utils/CustomCryptRC4.js`](https://github.com/merdok/homebridge-miot/blob/8d27204423a569e11c468830e3df324d278954ee/lib/utils/CustomCryptRC4.js) | `rc4.ts`                    | `f0c553bce61aff761b344c8647f4334d8d59569aa71074b3f3e3ac137cf56baf` |

上游 MIT 许可全文保留在 [LICENSE](LICENSE)，版权为 Copyright (c) 2025 Marcin。RC4 模块原有的 edomi-roboroc 来源说明保留在代码中。

passToken 续期遵循仓库固定版本 [go2rtc `LoginWithToken`](https://github.com/AlexxIT/go2rtc/blob/b5948cfb25404cc5cb37b166ecaa2dca20b11d4b/pkg/xiaomi/cloud.go#L345) 的同一米家账号协议：向 `account.xiaomi.com/pass/serviceLogin` 提交限定该主机及 `/pass` 路径的 `userId`／`passToken` Cookie，取得 `ssecurity` 和 STS 地址，再完成设备会话。该协议与 OAuth refresh token 无关；go2rtc 来源和 MIT 许可见 [构建目录](../../../../../docker/go2rtc/README.md)。

`node-fetch` 替换为 Bun 原生 `fetch`、`Headers.getSetCookie()` 和 `AbortSignal`；`randomstring` 替换为 `node:crypto`；`querystring` 替换为 `URLSearchParams`。[`tough-cookie` 6.0.2](https://github.com/salesforce/tough-cookie/releases/tag/v6.0.2) 的内存 `CookieJar` 负责 Cookie 解析、域名／路径匹配、过期、删除和同名 Cookie 排序。收到 `Max-Age` 时，使用库的 `expiryTime()` 计算并保存绝对过期时间，避免读取 Cookie 更新访问时间而延长寿命。Bun 版本沿用仓库 `packageManager` 和 `engines`。

`client.ts` 管理扫码、安全验证、会话和设备加密协议；`session.ts` 定义可导出授权的校验结构；`transport.ts` 持有 CookieJar 和请求生命周期。传输层逐跳校验目标仅为小米可信 HTTPS 地址，并按目标 URL 匹配 Cookie；凭据读取限定当前验证／STS 响应 URL。重定向遵循 Fetch 语义：301／302 将 POST 转为 GET，303 将非 GET／HEAD 转为 GET，307／308 保留方法及可重放的表单请求体；跨源跳转移除 Authorization。验证码提交额外拒绝一切跨 origin 重定向，不能把验证码请求体重放到其他主机。各跳及最终响应体读取共享一次超时与取消信号，错误分类以组合信号的首次中止原因为准，响应体限制为 4 MiB；`extension-pragma` 中的登录材料在每次跳转前交回账号协议处理。返回业务层时响应体已读取并释放。

## 生命周期

这里的会话是米家云账号／设备请求会话；go2rtc 的 `sessionId` 和心跳租约属于独立的媒体运行时资源，见[资源定义](../../../../../docs/mijia.md#组件与资源)。

每次扫码创建独立的 `new MiCloud({ region: "cn" })`。`createLogin()` 返回二维码图片数据、毫秒过期时间及轮询间隔，长轮询地址仅保留在实例内部。`pollLogin()` 持有该次登录的 cookie、设备标识与加密材料；登录完成时必须获得 `ssecurity`、`userId`、`serviceToken`、`passToken`。缺少任意材料均报告 `missing-credentials`。

若小米返回 `notificationUrl`，状态为 `security-required`。用户打开小米安全验证页面请求短信或邮件验证码，再通过 `submitSecurityCode()` 提交收到的数字验证码。验证码通过同次登录的 cookie 会话提交至小米验证接口；账号 token 不需要用户搬运。仅支持上游的 `authStart` 页面及电话／邮件验证类型，其他验证类型报告 `unsupported-security`。安全验证仍受原二维码过期时间约束。

`getDevices()` 使用这个实例完成的设备会话，并通过 `getHomes()` 查询 `/v2/homeroom/gethome` 与归属分页 `/v2/homeroom/get_dev_room_page`，合并家庭和房间。设备与目录请求使用同一 RC4 签名传输，未找到归属时返回空值，不推测安装位置。`homes.ts` 负责目录响应校验、分页和归属映射。

`getDeviceSpec()` 通过独立的 `spec.ts` 客户端读取 `miot-spec.org` 的公开型号 URN、规格实例和中文翻译，按 MiLoCo 精简规格结构解析属性访问能力与动作输入，使用 `writeable`、`value_range`、`in_params` 等字段；不对外输出事件或动作输出。该客户端不接收 Cookie、token 或设备控制凭据。规格不是实时属性值，不执行设备读取、订阅或控制。接口结构与缓存规则见[米家与摄像头](../../../../../docs/mijia.md#家庭房间与设备能力)。

`getCredentials()` 明确包含上游会话导出遗漏的 `passToken`，供 backend 比较续期前后的凭据，并通过 `Go2RtcAdapter` 将凭据安装到 go2rtc 运行时会话。设备与摄像头统一使用中国大陆区域 `cn`；其他区域被拒绝。

登录完成后清理账号登录 Cookie，只保留限于设备 API 主机和 `/app` 路径的协议 Cookie。STS 的 `serviceToken` 与设备协议要求的 `yetAnotherServiceToken` 使用相同的绝对过期时间；设备会话不会把登录 `passToken` 发送到设备 API。

`exportSession()` 返回 backend 专用的 `MiCloudSavedSession`，包含同次授权凭据、设备请求标识及 STS serviceToken Cookie 的绝对到期时间；上游未给到期时间时保存 `null`，不推测协议有效期。`MiCloud.restoreSession(value)` 校验导入结构并重建受限 Cookie，保留到期会话的 passToken 供续期；它不恢复二维码或验证码流程，过期 serviceToken 不能用于设备请求。

`renewSession(signal)` 使用独立实例和 CookieJar 完成 token 交换，检查用户身份一致，并返回候选会话；失败、取消和候选实例释放均不污染当前会话。调用者负责同一账号只执行一个续期任务、验证候选设备请求、持久化成功后再接管，以及销毁未接管的候选。backend 在恢复授权时先续期；运行中按已知到期时间提前最多 5 分钟续期，剩余时间较短时取其一半。无到期时间时每 6 小时主动重新验证，这是本应用策略而非小米承诺的有效期。网络失败保留旧凭据并退避重试；明确拒绝 passToken 或再次要求安全验证时重新扫码，协议或存储错误需显式重试。passToken 未轮换且媒体仍就绪时，接管设备会话不重建摄像头流。

导出值和续期候选均包含秘密，不能进入浏览器、普通配置、日志或追踪。真实账号的持续续期仍需实机验收。

`dispose()` 中止在途请求并清理 cookie、扫码状态及凭据。所有异步登录结果在写入会话前检查取消状态与二维码期限；调用者仍须检查当前业务会话身份，以避免已经完成的旧请求提交到新的绑定流程。过期或取消后必须创建新实例。

原始设备数据只在 backend 内部使用，返回浏览器前必须投影字段白名单。本模块不提供 logger，不记录请求、响应、cookie、URL、二维码或验证码；所有错误均为静态 `MiCloudError.code`，不包含上游消息或底层异常 cause。调用者的日志和追踪同样不得记录本模块参数、返回值或实例。

真实扫码、安全验证与具体摄像头型号兼容性需要在实际账号和设备上验收；编译通过不代表已经完成实机验证。
