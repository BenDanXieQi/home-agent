# Web

基于 React、Vite、Tailwind CSS 4、TanStack Router / Query、Jotai、React Hook Form、Radix 与 Motion 的本机家庭工作台。

当前提供账号登录、设备列表、摄像头预览和设置，尚无聊天、家庭语义展示或建模界面。视频预览只展示摄像头画面，不包含人物识别或活动判断。项目的家庭语义目标见[领域模型规划](../../docs/plans/household-model.md)，不属于当前页面已实现能力。

## 运行

在仓库根目录执行 `bun run dev`，访问 <http://127.0.0.1:5173/>。Vite 将 `/api` 代理到根目录 `.env` 中配置的 backend 地址。生产环境执行 `bun run start`，通过 backend 的 HTTP 端口访问。Vite 静态预览不提供 API 代理。

## 使用流程

设备和摄像头仅展示 backend 所选家庭的范围。在“设置 → 米家家庭”发起选择后，页面通过状态订阅显示保存和初始化进展；也可清除选择以暂停接入。未选择或所选家庭不可访问时设备列表为空。这里的设备清单包括家庭、房间、设备及其归属信息；公共状态是 backend 提供给页面读取的账号、家庭、清单、规格和媒体等信息。

未登录时显示米家登录页，自动获取二维码并在后端报告过期后自动刷新；用户可手动刷新或取消，请求失败后显示重试入口。恢复保存会话和安全验证期间不自动创建新扫码尝试。已保存的授权由 backend 恢复，浏览器不保存账号凭据；恢复失败时可以重试或清除授权。已登录账号窗口只显示账号信息和退出操作，更换账号先退出再扫码。账号授权与扫码尝试分别从公共状态派生为 `account`、`loginAttempt`，摄像头暂停选择随新登录会话或家庭访问失效清空。退出清理失败时保留错误和重试清理入口，清理完成后自动获取二维码。

自动取码的启动条件由 `mijiaCanStartLoginAutomaticallyAtom` 从账号、扫码尝试、命令和读取状态派生。`LoginFlow` 的 effect 仅在启动条件变化时调用 `startMijiaLoginAutomaticallyAtom`；该命令执行前再次读取共享状态，并复用 `performMijiaAtom` 同步设置的 pending 标志防止重复派发。组件不使用 `useRef` 记忆“已经请求过”，因此 StrictMode 重跑和组件重新挂载共用同一启动规则。取码请求失败后停止自动尝试，保留显式重试；按钮操作仍由事件处理器直接执行。扫码任务由 backend 持有，effect 不创建独立计时器，也不在组件卸载时取消服务端尝试。

从根路径开始扫码并登录成功后，先打开设置检查连接状态。已有授权恢复时进入设备页；直接打开或刷新设备、摄像头及设置的深链时保留目标页面。读取首个账号快照期间显示加载状态。侧栏包含设备、摄像头和设置，底部为账号入口。窄屏保留可展开的图标导航，各入口均有可访问名称。

| 路径        | 内容                                                   |
| ----------- | ------------------------------------------------------ |
| `/`         | 等待账号快照；恢复授权进入设备页，新扫码完成进入设置   |
| `/devices`  | 设备列表、搜索，以及房间、分类、能力和在线状态筛选     |
| `/cameras`  | 平铺显示全部镜头，家庭及媒体连接就绪后分别建立播放连接 |
| `/settings` | 连接检查、服务地址配置，以及摄像头接入重试             |

摄像头按名称自然排序，同名时按设备 ID 排序，刷新不沿用云端返回顺序。多镜头设备按支持的通道显示，镜头按 1、2 排列。每个镜头各占一格，每格独立管理播放预约、WebRTC 连接、重试和出帧状态。关闭一路不会停止其他画面；暂停选择在当前摄像头页内跨媒体运行标识 `revision` 的变化和短暂离线保留，切换账号、家庭或离开页面后清空。`revision` 在媒体失效或重新绑定时更换，用于拒绝旧播放请求。离开页面会释放浏览器观看连接，由 backend 管理的 go2rtc 摄像头共享流继续取流；视频不经过 backend。清单中的在线字段只作提示，不单独阻止播放，能否出帧由实际媒体连接决定。使用限制见[米家与摄像头](../../docs/mijia.md)。

设置之外的页面通过右下角状态卡片提示连接问题。卡片可收起，并提供返回设置的入口；提示统一结合服务可达性和米家摄像头绑定状态。Agent 未连接不影响已经就绪的摄像头预览。

## 代码组织

- `src/pages/`：`LoginPage`、`DevicesPage`、`CamerasPage` 和 `SettingsPage` 页面入口。
- `src/features/mijia/`：强类型 API 命令、查询定义、状态、登录与账号交互、设备列表、摄像头网格及播放器。
- `src/features/connections/`：服务配置、连接状态、backend 健康状态、查询定义、状态与连接提醒。
- `src/components/`：共享按钮、请求反馈、折叠说明、离开确认弹窗与 Provider。
- `src/lib/api.ts`：Hono RPC 客户端、共享响应校验、错误归一化、取消、超时和具名重试策略。
- `src/lib/query-client.ts`：共享 QueryClient；`src/lib/store.ts` 将同一实例注入 Jotai。
- `src/state/ui.ts`：共享导航、账号弹窗与连接提醒的界面状态。
- `src/index.css`：Tailwind 入口、主题、基础元素与减少动态效果规则；`src/styles/` 放共享组件及工作台布局，功能样式分别放在 `features/mijia/mijia.css` 和 `features/connections/connections.css`，由入口统一导入。

工作台页面挂在无路径的 `account` 父路由下。`AccountGate` 统一处理首个账号快照、未登录界面、根路径登录后导航和账号失效，保留设备／摄像头／设置的目标 URL；`App` 只负责工作台布局。`AccountGate` 读取已有的家庭公共状态，不额外发鉴权请求；同账号恢复期间可展示已保存的设备清单，但不能据此开始读取或播放。界面的登录检查不阻止路由模块预加载，也不替代 API 的访问校验。

`RetryConnectionButton` 复用派生 atom 的重试条件与运行状态，登录、摄像头和设置页不各自判断。`RequestFeedback` 分别展示可重新读取的查询错误与操作错误；字段级校验继续由表单处理。活跃扫码状态判定由共享协议模块提供，供登录材料读取和界面共同使用。

家庭公共状态由应用级 SSE 订阅写入 `householdSnapshotAtom`，每个标签页共用一条连接，页面切换不会重复建立订阅。派生 atom 从这份状态计算界面所需字段。服务配置、服务检查和 backend 健康检查继续使用 `serviceConfigQueryOptions`、`serviceStatusQueryOptions` 和 `backendHealthQueryOptions` 的 Query 缓存；二维码与安全验证材料按登录尝试 ID 和材料版本单独读取，不进入公共状态。

`performMijiaAtom` 是可写的异步 atom，接受 `MijiaCommand` 判别联合类型，支持 `startLogin`、`verifyLogin`、`cancelLogin`、`retryConnection`、`logout`、`refreshDevices` 和 `selectHome`。React 组件通过 `useSetAtom` 调用，组件外通过同一应用 Store 的 `appStore.set` 调用。命令默认互斥并取消过时的请求；验证码提交期间继续接收 SSE，取消登录和重新扫码可以中止当前验证等待并发起新命令。每次命令持有独立请求序号及取消控制器，旧响应、错误和结束回调不能覆盖新命令。

命令按自身所需信息发起，不以 SSE 已连接为通用前提。首次选择家庭和刷新设备清单必须有已取得的 `scope_epoch`，断流时可携带最后已知值，由 backend 拒绝过期作用域；没有标识就不发送请求，也不补空值。取消和验证登录必须指定尝试 ID。退出、手动开始登录和重试连接使用对应账号命令，不要求先取得快照；首次状态仍不可用时，登录页提供手动登录和清除授权入口。自动取码继续要求公共状态已同步。

命令响应只返回操作结果和 `state_version`，不写入公共快照。HTTP 请求结算后立即结束本地 pending；`mijiaCommandSyncPendingAtom` 独立表示页面是否已看到接纳版本，未追上时提示“操作已接收，正在等待状态同步…”，不把已接受的操作改报失败，也不占用命令锁。确认条件是同一 epoch 的 sequence 已达到回执，或 HTTP 结算后重新订阅取得完整当前快照；后者允许后台已经进入比回执更新的作用域。这份确认不表示后台设备清单刷新已经完成。浏览器至 backend 的网络及超时提示可在新状态消息到达后消除，验证码拒绝等业务失败不会因此清除。

退出期间暂停新播放；HTTP 成功后，旧快照和旧心跳不能越过回执恢复播放，须满足上述版本或完整快照确认。HTTP 结果不确定时，须重新订阅取得完整快照。`householdSnapshotReceivedAtom` 只记录完整快照的接收次数，普通增量和心跳不递增它。单纯 SSE 短断不额外限制播放，也不拆除已有画面；账号替换和媒体重建仍由 `revision` 使旧播放失效。验证码只存在于表单和当前请求执行过程中，提交后清空表单，不进入 MutationCache 或界面 atom。

恢复登录与重新绑定是后台操作：HTTP 202 表示请求已接收，`restoring`／`installing` 等进展通过 SSE 更新。相关按钮结合当前 HTTP 请求与已同步的服务端忙态防止重复触发；断流后的陈旧忙态不阻止手动重试。

服务配置使用 Query mutation，其 observer 在切换页面时保持存活。所有本机 API 查询与 mutation 均使用 `networkMode: "always"`，浏览器的 offline 事件不会阻止请求本机 backend；实际请求仍受超时限制。

## 状态订阅与播放

登录、授权恢复、设备加载和摄像头绑定进展通过同一 SSE 订阅更新，不轮询米家状态。新连接先接收完整快照，再按连续版本应用变化；断流时可保留旧显示并标为未同步，切换账号或家庭时清除旧快照。自动重连、手动重连和页面恢复可见都遵守同一最早重连时间及服务器 `Retry-After`。服务连接仍每 10 秒检查一次，backend 健康状态仍每 30 秒检查一次；这些 Query 检查在后台标签页暂停，恢复焦点或网络连接后刷新。

摄像头页使用应用已有的公共状态；尚未收到状态时显示确认提示，页面挂载不触发设备清单刷新。开始播放要求账号、所选家庭和媒体连接均已就绪；退出操作还须按命令回执或之后重新取得的完整快照确认作用域。普通设备清单刷新及短暂错误保留观看连接；新登录会话或家庭访问失效、设备访问撤销、媒体运行标识 `revision` 变化时，才清理对应旧观看资源。播放器的 key 包含 `revision`、设备和通道，无关状态更新不会重建连接；暂停选择由当前家庭的摄像头网格单独保存。

播放预留和 SDP 信令通过 backend 完成，视频经 go2rtc 的 WebRTC 连接直接到达浏览器；协商成功不等于已经出帧。隐藏标签页或将画面滚出视口只暂停可见画面的检测，不等同于关闭播放。资源术语见[组件与资源](../../docs/mijia.md#组件与资源)。

`use-mijia-playback.ts` 在单个 effect 内管理每路播放的 ICE、视频帧回调、首帧与画面停滞超时，并统一释放资源；等待提示中的秒数由共享超时配置推导。`MijiaPlayer.tsx` 负责显示状态、播放开关和重新播放。资源由每次 hook 调用独立持有，不进入共享 Store。React Hook Form 在刷新时保留已修改的服务地址，保存成功后重置表单基线；离开确认弹窗保护未保存的编辑，取消离开后恢复原焦点。账号窗口关闭后，焦点回到侧栏账号按钮。

登录页、账号窗口、设备列表和摄像头网格按需加载，设备列表的代码包不包含摄像头播放实现。Motion 动画功能异步加载，过渡遵循减少动态效果的系统偏好。布局与颜色由 Tailwind 主题定义。

## 检查

```sh
bunx turbo run lint check-types --filter=@home-agent/web
bunx turbo run build --filter=@home-agent/web
```

构建包含 TypeScript 检查，Oxfmt 负责格式化。API 契约来自 `@home-agent/api/contracts` 和 `@home-agent/api/mijia`。`VITE_*` 变量会暴露给浏览器，不得存放凭据。

## 类型化 HTTP 客户端

所有浏览器到 backend 的请求使用 `@home-agent/backend/client` 导出的 `createBackendClient`，由 Hono `hc` 从链式路由推导路径、方法、路径参数、JSON 输入和响应。功能模块不拼接 API 路径，不手写 JSON 序列化，也不直接调用 fetch。`packages/api` 继续定义运行时 Zod 协议、错误和 HTTP 语义；客户端请求辅助函数同时检查 RPC 响应类型与校验器输出类型。

`createApiClient(baseUrl, fetchImpl)` 注入传输，默认使用同源路径和浏览器 fetch。功能调用通过回调取得该客户端及请求选项，统一执行超时、取消和错误处理。例如：

```ts
requestJson(
  (client, options) => client.api.config.$get({}, options),
  configResponseSchema,
  { signal },
);
```

`requestJsonResponse` 额外返回解析后的 `Retry-After`，`requestEmpty` 验证 204 响应。播放释放沿用 keepalive。重试默认关闭；播放 offer 显式选择 `retryOnceOnTransportFailure`，最多重发一次相同参数。每次请求沿用调用方的 `timeoutMs`，播放器的取消信号统一约束首次请求和重试，总协商期限为 85 秒，不因重试重新计时。HTTP 业务错误和响应校验失败不自动重试，后台生命周期恢复继续由 backend 管理。

RPC 声明由 backend 的 `build:rpc` 生成到 `dist/rpc`，不提交 Git。Turborepo 在 Web 检查和构建前生成声明；根目录 `bun run dev` 或 `bun run dev:web` 同时运行声明 watcher。单独调用 Web 包脚本前需先执行 `bun run --cwd apps/backend build:rpc`。声明和客户端运行时代码都不引入服务端实现到浏览器包；SSE 接口通过类型化客户端返回原始流，不使用 JSON 响应辅助函数。

家庭设置只在首次未绑定时通过 `GET /api/mijia/setup/homes` 读取候选；正常页面显示固定绑定，失去权限后提示恢复原家庭访问。纠错需停机修改绑定后重启。完整规格与候选家庭不进入公共快照。
