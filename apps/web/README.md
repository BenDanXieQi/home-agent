# Web

基于 React、Vite、Tailwind CSS 4、TanStack Router / Query、Jotai、React Hook Form、Radix 与 Motion 的本机家庭工作台。

当前提供账号登录、设备列表、摄像头预览和服务设置，尚无聊天、家庭语义展示或建模界面。视频预览只展示摄像头画面，不包含人物识别或活动判断。项目的家庭语义目标见[领域模型规划](../../docs/plans/household-model.md)，不属于当前页面已实现能力。

## 运行

在仓库根目录执行 `bun run dev`，访问 <http://127.0.0.1:5173/>。Vite 将 `/api` 代理到根目录 `.env` 中配置的 backend 地址。生产环境执行 `bun run start`，通过 backend 的 HTTP 端口访问。Vite 静态预览不提供 API 代理。

## 使用流程

未登录时显示米家登录页，自动获取二维码并在后端报告过期后自动刷新；用户可手动刷新或取消，请求失败后显示重试入口。恢复保存会话和安全验证期间不自动创建新扫码尝试。已保存的授权由 backend 恢复，浏览器不保存账号凭据；恢复失败时可以重试或清除授权。已登录账号窗口只显示账号信息和退出操作，更换账号先退出再扫码。账号授权与扫码尝试分别读取 `account`、`loginAttempt`，摄像头选择由账号 ID 隔离。退出清理失败时保留错误和重试清理入口，清理完成后自动获取二维码。

自动取码的准入由 `mijiaCanStartLoginAutomaticallyAtom` 从账号、扫码尝试、命令和读取状态派生。`LoginFlow` 的 effect 仅在准入变化时调用 `startMijiaLoginAutomaticallyAtom`；该命令执行前再次读取共享状态，并复用 `performMijiaAtom` 同步设置的 pending 标志防止重复派发。组件不使用 `useRef` 记忆“已经请求过”，因此 StrictMode 重跑和组件重新挂载共用同一准入规则。取码请求失败后停止自动尝试，保留显式重试；按钮操作仍由事件处理器直接执行。扫码任务由 backend 持有，effect 不创建独立计时器，也不在组件卸载时取消服务端尝试。

从根路径开始扫码并登录成功后，先打开服务设置检查连接状态。已有授权恢复时进入设备页；直接打开或刷新设备、摄像头及设置的深链时保留目标页面。读取首个账号快照期间显示加载状态。侧栏包含设备、摄像头和服务设置，底部为账号入口。窄屏保留可展开的图标导航，各入口均有可访问名称。

| 路径        | 内容                                                 |
| ----------- | ---------------------------------------------------- |
| `/`         | 等待账号快照；恢复授权进入设备页，新扫码完成进入设置 |
| `/devices`  | 设备列表、搜索，以及在线设备和摄像头筛选             |
| `/cameras`  | 平铺显示全部摄像头，在线摄像头各自建立播放连接       |
| `/settings` | 连接检查、服务地址配置，以及摄像头接入重试           |

多镜头设备按支持的通道显示。每个镜头各占一格，每格独立管理播放预约、WebRTC 连接、重试和出帧状态。关闭一路不会停止其他画面；暂停选择在当前摄像头页内跨媒体代次 `revision` 和短暂离线保留，切换账号或离开页面后清空。离开页面会释放浏览器观看连接，由 backend 管理的 go2rtc 摄像头共享流继续取流；视频不经过 backend。云端首次报告离线时，后端可短暂保留已建立的镜头，页面标明“离线状态确认中”；保留结束后转入紧凑离线列表。使用限制见[米家与摄像头](../../docs/mijia.md)。

服务设置之外的页面通过右下角状态卡片提示连接问题。卡片可收起，并提供返回设置的入口；提示统一结合服务可达性和米家摄像头绑定状态。Agent 未连接不影响已经就绪的摄像头预览。

## 代码组织

- `src/pages/`：`LoginPage`、`DevicesPage`、`CamerasPage` 和 `SettingsPage` 页面入口。
- `src/features/mijia/`：强类型 API 命令、查询定义、状态、登录与账号交互、设备列表、摄像头网格及播放器。
- `src/features/connections/`：服务配置、连接状态、backend 健康状态、查询定义、状态与连接提醒。
- `src/components/`：共享按钮、请求反馈、折叠说明、离开确认弹窗与 Provider。
- `src/lib/api.ts`：Hono RPC 客户端、共享响应校验、错误归一化、取消、超时和具名重试策略。
- `src/lib/query-client.ts`：共享 QueryClient；`src/lib/store.ts` 将同一实例注入 Jotai。
- `src/state/ui.ts`：共享导航、账号弹窗与连接提醒的界面状态。
- `src/index.css`：Tailwind 入口、主题、基础元素与减少动态效果规则；`src/styles/` 放共享组件及工作台布局，功能样式分别放在 `features/mijia/mijia.css` 和 `features/connections/connections.css`，由入口统一导入。

工作台页面挂在无路径的 `account` 父路由下。`AccountGate` 统一处理首个账号快照、未登录界面、根路径登录后导航和账号失效，保留设备／摄像头／设置的目标 URL；`App` 只负责工作台布局。守卫复用已有查询缓存，不额外发鉴权请求。这是响应式 UI 守卫，不阻止路由模块预加载，也不替代 API 的访问校验。

`RetryConnectionButton` 复用派生 atom 的重试准入与运行状态，登录、摄像头和设置页不各自判断。`RequestFeedback` 分别展示可重新读取的查询错误与操作错误；字段级校验继续归表单所有。活跃扫码状态判定由共享协议模块提供，供轮询和界面共同使用。

业务查询定义随功能归属，包括 `mijiaStateQueryOptions`、`serviceConfigQueryOptions`、`serviceStatusQueryOptions` 和 `backendHealthQueryOptions`。服务端数据只保存在 Query 缓存中，派生 atom 仅提供使用方需要的状态。

`performMijiaAtom` 是可写的异步 atom，接受 `MijiaCommand` 判别联合类型，支持 `startLogin`、`verifyLogin`、`cancelLogin`、`retryConnection`、`logout` 和 `refreshDevices`。React 组件通过 `useSetAtom` 调用，组件外通过同一应用 Store 的 `appStore.set` 调用。命令默认互斥并取消过时的读取；验证码提交期间继续轮询，取消登录和重新扫码可以中止当前验证等待并发起新命令。每次命令持有独立请求序号及取消控制器，已被替换的响应、失败处理和结束回调不能覆盖新命令。成功后将快照写入 Query 缓存，失败或结果不确定时补查状态。浏览器至 backend 的网络及超时提示在新的成功快照后消除；验证码拒绝等业务失败不因普通轮询成功而被清除。退出账号的命令必须取得新的成功快照才允许重新播放；账号替换和媒体重建由 backend 的媒体代次 `revision` 使旧播放失效；普通轮询失败不拆除已有画面。验证码只存在于表单和当前请求执行过程中，提交后清空表单，不进入 MutationCache 或界面 atom。

恢复登录与重新绑定是后台操作：HTTP 202 快速返回 `restoring`／`installing` 状态，页面继续轮询进展。相关按钮依赖服务端状态防止重复触发，不用长时间的 HTTP pending 锁住所有操作。

服务配置使用 Query mutation，其 observer 在切换页面时保持存活。所有本机 API 查询与 mutation 均使用 `networkMode: "always"`，浏览器的 offline 事件不会阻止请求本机 backend；实际请求仍受超时限制。

## 轮询与播放

登录、授权恢复、设备加载和摄像头绑定安装期间，每 2 秒查询一次状态。账号状态稳定后每 10 秒查询一次；登录空闲或取消后每 30 秒查询一次。服务连接每 10 秒检查一次，backend 健康状态每 30 秒检查一次。后台标签页暂停定时轮询，恢复焦点或网络连接后刷新。

进入摄像头页后，必须先取得新的状态快照才能播放，等待期间显示正在确认账号与摄像头状态。改变账号或绑定归属的命令会暂时隐藏画面，直到后端状态刷新完成。设备刷新保留观看连接；短暂的刷新错误也不会中断现有画面，页面同时显示错误。账号或绑定归属变化时，由 backend 的账号和媒体代次 `revision` 检查撤销旧媒体连接。播放器的 key 包含 `revision`、设备和通道，无关状态更新不会重建连接；暂停选择由当前账号的摄像头网格单独保存。

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
