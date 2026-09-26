# Home Agent

Home Agent 是一个通过家庭情景推断驱动全屋自动化的 Agent 项目。它对成员、空间、设备及事件之间的关系进行建模，从分散的观察中推断人员活动和房间情况，并持续更新这些判断，作为全屋任务的决策依据。

## 项目动机

人在传感器的“有人／无人”结果并不总能反映真实情况。在卧室，睡觉的人盖着被子、长时间不动，可能检测不到；另一个人进来拿东西，传感器才报有人，自动化随即打开主灯，把睡觉的人吵醒。卧室之外，猫狗走动也可能被当成人的活动，导致突然开灯，或明明人已离开，灯却一直不关。

设备给出的往往只是几条零散消息：房间有人、灯关了、手机息屏了。Home Agent 希望结合这些消息和之前的活动，判断家人是否正在准备休息；之后有人走动、开门或使用手机时，继续判断情况有没有改变，而不是立刻认为所有人都醒了。

项目参考了 [MiLoCo](https://github.com/XiaoMi/xiaomi-miloco/tree/cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8) 的家庭感知思路，但其现有实现还需要补充跨设备持续跟进成员活动与空间变化的能力；[自定义许可证](https://github.com/XiaoMi/xiaomi-miloco/blob/main/LICENSE.md)也未授权将其作品用于开发其他应用或 Web 服务。Home Agent 因此选择独立实现。

## 核心设计

1. **逐步建立家庭资料。** 家庭成员与宠物、房间布局、设备位置和覆盖范围，既可以由用户提供，也可以由 AI 结合设备目录、日常观察和交互逐步识别、整理与更新，减少手动配置；拿不准的信息再向用户询问。
2. **从观察推断情景，并持续跟进。** 结合多种信号及事件顺序，推断设备没有直接上报的活动与房间状态。每个人、宠物和空间分别保留当前判断与依据；后续观察用于确认、修正或结束相关判断，缺失的消息不能直接解释为人员离开或活动结束。
3. **让全屋任务使用同一份情景。** 推断结果进入持续运行的家庭状态系统，供 Agent 和自动化任务查询。灯光、空调、音箱等动作同时考虑相关成员、相邻空间和有效要求；执行结果再成为后续判断的输入。

家庭状态由 backend 维护，Agent 参与情景推断和任务规划；长期记忆另行提炼偏好与经验，不代替当前状态。

详细设计与实施边界见[家庭语义目标与领域模型](docs/plans/household-model.md)。

## 当前能力

已实现米家登录与授权恢复、家庭选择与目录持久化、后台规格准备、SSE 状态订阅、多摄像头预览，以及流式对话 API、会话持久化和调用追踪。

上述设计目标尚未实现。backend 已提供指定属性读取、MQTT 属性／在线观察和限时上报日志，尚未将其接入持续采集与家庭状态仲裁。视觉理解、设备控制，以及 Agent 的家庭数据、语音和长期记忆尚未接入；Web 暂无聊天界面。仅供可信本机使用。

## 当前服务分工

技术栈：Bun、TypeScript、React、Hono、LangGraph、PostgreSQL 和 go2rtc。

| 模块           | 已实现职责                                                        |
| -------------- | ----------------------------------------------------------------- |
| `apps/backend` | 米家接入、授权与设备目录、摄像头播放管理、聊天转发及 Web 静态托管 |
| `apps/agent`   | 独立模型调用服务、流式对话、会话 checkpoint 与执行追踪            |
| `apps/web`     | 登录、设备列表、摄像头预览和服务设置                              |
| go2rtc         | 摄像头取流与浏览器 WebRTC 媒体连接                                |

backend 与 Agent 运行在独立进程中，通过 HTTP 通信，由项目启动命令统一管理。

## 快速开始

需要 Bun ≥ 1.4.2 和已运行的 Docker。摄像头预览需要本机能访问摄像头所在局域网；Docker 模式请先完成[网络设置](docs/running.md#docker-摄像头网络)。

```sh
bun install --frozen-lockfile
bun run setup
```

编辑生成的 `.env`，使 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 中的密码一致。`POSTGRES_PORT` 设置 Docker 数据库的宿主机端口，须与 `DATABASE_URL` 中的端口一致；若本机 5432 已被占用，可将两处端口设为 5433。使用对话 API 时还需配置 `AGENT_MODEL`、`OPENAI_API_KEY`，按需填写 `OPENAI_BASE_URL`。

```sh
bun run db:up
bun run db:migrate
bun run dev
```

打开 <http://127.0.0.1:5173/>，使用米家 App 扫码登录。设备与摄像头仅接入已选择的家庭；首次使用请在“设置 → 米家家庭”选择要接入的家庭。日常运行 `bun run dev`，停止应用与依赖使用 `bun run stop`。新增数据库迁移后需重新执行 `bun run db:migrate`。

本机配置与凭据不提交 Git。恢复已有数据库授权时，还需恢复对应的凭据加密密钥；详见[米家与摄像头](docs/mijia.md)。

## 文档

- [家庭语义目标与领域模型（规划）](docs/plans/household-model.md)：项目目标、backend 与 Agent 边界、语义模型及场景验收
- [设备感知实施计划（规划）](docs/plans/backend-household-perception.md)：设备接入、状态、历史、Web 同步与 Agent 基础接入六步
- [本地运行](docs/running.md)：运行模式、Docker 网络、服务连接配置与开发命令
- [米家与摄像头](docs/mijia.md)：登录、预览、授权保存与支持范围
- [家庭运行时](docs/household.md)：目录、规格、作用域与公共状态订阅
- [米家来源契约](docs/reference/mijia-source-contract.md) · [设备接入代码参考](docs/reference/device-access-code-reference.md)
- [Agent 与对话 API](apps/agent/README.md)
- [后端与数据库](apps/backend/README.md) · [前端](apps/web/README.md)
- [go2rtc 构建](docker/go2rtc/README.md)
- [调用追踪](packages/observability/README.md) · [共享契约与错误处理](packages/api/README.md)
