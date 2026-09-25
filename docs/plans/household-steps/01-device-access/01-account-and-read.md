# 任务 1.1：统一账号、目录与属性读取

**状态：待执行。** 只执行本任务，完成后停止。

[阶段入口](README.md) · 下一任务：[1.2 属性与在线推送](02-mqtt-push.md)

## 开始前

- 遵守仓库 AGENTS.md，读取 AGENTS.local.md，按其中路径只读核对 MiLoCo。
- 阅读 [共同参考](reference.md) 的 OAuth、账号映射、HTTP 编码、属性读取、交付位置、来源能力矩阵、调用范围与验收入口、验证交接；阅读 [总览共同检查](../../backend-household-perception.md#每步共同检查)。
- 前置基础是现有米家扫码登录、目录及规格查询。检查实际工作区，不重做已有功能。

## 本次范围

先阅读 [目录架构](architecture.md)，按其迁移表将现有模块移到最终位置，同批更新调用方、共享契约和文档。

交付正式 OAuth 授权与一次性属性读取。协议位于 apps/backend/src/mijia/protocols/miot/oauth.ts、http-client.ts，读取编排与来源配置位于 properties/；由现有 service.ts 协调账号，在现有账号页面交付授权入口。此任务不创建 MQTT 实现或占位接口。

## 实施清单

- [ ] 按架构文件重组 account、devices、media、protocols/micloud；保留一个账号所有者和一个业务设备目录，删除原路径和转发别名，不新增通用 provider 层。

- [ ] 按共同参考的调用范围，从当前账号已同步目录中显式选取代表设备／属性及拓扑，建立来源能力矩阵；后续推送／在线能力记待验证，独立设备事件记未接入。
- [ ] 按 MiLoCo cloud.py 的 MIoTOAuth2Client 实现授权 URL、code/state 校验、token 交换；不是同目录通用 oauth2.py。应用 ID、官方回调与请求编码均采用共同参考。
- [ ] 调用 profile 与 get_uid_by_unionid，将 OAuth uid 与扫码 userId、cn 区域核对；匹配后才能用于当前账号设备。失败返回实际原因，不猜昵称或设备重叠。
- [ ] OAuth 材料独立存入现有加密凭据存储；账号所有者负责恢复、续期、解绑和换账号清理。按参考有效时间及提前量管理一个续期任务，更新 HTTP token；本次不预造 MQTT 续期接线。
- [ ] 同批接入现有账号页面和正式授权命令：生成 URL、用户授权、提交 code/state、展示授权结果。材料不进入公开家庭状态，不写一次性授权脚本。扫码媒体继续使用其原凭据。
- [ ] 交付正式内部 readProperties(properties, signal)，返回逐项观测；按参考实现 HTTP 编码和属性读取；共用串行批次，每批最多 150 项、单次 30 秒，支持 AbortSignal。逐项按 [MiLoCo 返回码规则](reference.md#属性读取返回码) 处理，保留 -702000000／-702010000 的接受语义，不以非零或负数一律判失败；只接收本批请求的 did/siid/piid；缺失 value 不补 null，部分失败不清掉成功项。
- [ ] 输出 baseline/cloud_cache、observed_at=null 和 read_started_at／received_at，不把缓存响应当设备实时观测。建立可复用的 properties/source-profiles.ts 读取配置，不增加周期轮询。

## 验收与交接

- [ ] 联合验证现有扫码登录、设备目录、规格、摄像头播放和释放；OAuth 状态独立展示且绑定同一账号，新增授权不能破坏已有通路。

- [ ] 当前账号完成真实 OAuth 授权、uid 匹配与属性读取；保存脱敏证据。
- [ ] 核验凭据恢复及续期、账号不匹配、普通失败负码与接受类负码、缺失 value、超时取消、解绑清理；实机与实现审查分别记录，无法验证的项目不标通过。
- [ ] 更新 docs/mijia-source-contract.md 的读取契约及矩阵；按共同参考保存 task_id=1.1 的 report.json，标明代表能力，供任务 1.2 复用。
- [ ] 完成总览共同检查；记录本任务状态、代码入口、实机报告位置和真实限制。不新增测试或兼容路径。

**完成条件：** 目录迁移与统一账号／设备接线完成，已有登录、目录和视频通过验证；正式授权链、账号绑定、加密保存／恢复／续期、取消清理和真实属性读取交付，相关验收有证据。尚未接 MQTT 是任务边界，不以模拟推送补齐。前置授权受阻时完成不依赖授权的实现，记录具体阻塞，不宣称实机通过。
