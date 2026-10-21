# MiCloud adapter

本模块将 [homebridge-miot](https://github.com/merdok/homebridge-miot) 的独立 MiCloud 协议代码移植为 Bun TypeScript 模块，提供米家二维码登录、短信／邮件安全验证、授权会话导出与恢复、passToken 会话续期，以及设备清单、属性读取、属性写入和动作调用的加密请求。设备清单包含家庭、房间、设备及其归属。会话保存、凭据加密和续期调度由 backend 负责；本模块不包含 Homebridge、密码登录或 OAuth。

## 固定来源与许可

上游固定 commit：`8d27204423a569e11c468830e3df324d278954ee`。

passToken 续期遵循仓库固定版本 [go2rtc `LoginWithToken`](https://github.com/AlexxIT/go2rtc/blob/b5948cfb25404cc5cb37b166ecaa2dca20b11d4b/pkg/xiaomi/cloud.go#L345) 的同一米家账号协议：向 `account.xiaomi.com/pass/serviceLogin` 提交限定该主机及 `/pass` 路径的 `userId`／`passToken` Cookie，取得 `ssecurity` 和 STS 地址，再完成设备会话。该协议与 OAuth refresh token 无关；go2rtc 来源和 MIT 许可见 [构建目录](../../../../../../docker/go2rtc/README.md)。

## 摄像头通道能力

`camera-capabilities.json` 保存从小米官方 MiLoCo 的 [`camera_extra_info.yaml`](https://github.com/XiaoMi/xiaomi-miloco/blob/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8/backend/miot/src/miot/configs/camera_extra_info.yaml) 抽取的通道数量事实，包含上游版本、路径和原文件 SHA-256。该版本声明 7 款双摄；未列入额外能力表的摄像头采用单通道，与同版本 `MIoTClient.get_cameras_async` 的规则一致。运行时不请求 GitHub，也不按型号名称包含“dual”等字样猜测镜头数。更新这份通道能力表时应从固定上游重新抽取并同步来源信息，不在业务或 Go 代码中添加型号分支。

这里只提取通道数量，没有照搬 MiLoCo 原生摄像头 SDK 的设备白名单和黑名单；本项目的取流协议支持范围仍由 go2rtc 决定。

`camera-count` 是 MIoT `camera-control` 服务的可选属性，并非所有双摄都提供；已核对的 7 款中有 6 款公开规格未声明它。`audio-channel` 表示声道数，不能用于判断镜头数。因此当前通道清单使用官方能力表，不宣称能自动识别表中未列出的所有新双摄。通道能力声明也不等同于所有型号的媒体协议已实机通过。

后台将通道能力作为 `channelCount` 传给媒体适配器。当前媒体实现支持 1／2 个镜头；更大的声明不会被截断成两路。双摄使用 MISS 的 `videoquality`／`videoquality2` 联合启动、`flags` 高字节分流，默认画质沿用 go2rtc 既有规则。实机回归仅覆盖部分已授权单摄与双摄样本；其他设备及部署条件仍须单独验证，能力识别与实际播放证据分开记录。

## 生命周期

这里的会话是米家云账号／设备请求会话；go2rtc 的 `sessionId` 和心跳租约属于独立的媒体运行时资源，见[资源定义](../../../../../../docs/mijia.md#组件与资源)。

公开设备规格由独立的 [`spec/`](../spec/README.md) 协议客户端读取，不使用本模块的账号会话。

登录完成后清理账号登录 Cookie，只保留限于设备 API 主机和 `/app` 路径的协议 Cookie。STS 的 `serviceToken` 与设备协议要求的 `yetAnotherServiceToken` 使用相同的绝对过期时间；设备会话不会把登录 `passToken` 发送到设备 API。

导出数据和续期返回的新会话均包含凭据，不能进入浏览器、普通配置、日志或追踪。真实账号的持续续期仍需实机验收。

原始设备数据只在 backend 内部使用，返回浏览器前只保留允许公开的字段。本模块不提供 logger，不记录请求、响应、cookie、URL、二维码或验证码；所有错误均为静态 `MiCloudError.code`，不包含上游消息或底层异常 cause。调用者的日志和追踪同样不得记录本模块参数、返回值或实例。

真实扫码、安全验证与具体摄像头型号兼容性需要在实际账号和设备上验收；编译通过不代表已经完成实机验证。
