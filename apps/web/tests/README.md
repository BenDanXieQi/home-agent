# 米家接入业务逻辑测试

在仓库根目录安装依赖后运行：

```sh
bun run --cwd apps/web test
bun run --cwd apps/web test -- tests/state.test.ts
bun run --cwd apps/web check-types
bun run --cwd apps/web lint
```

测试以 [设备接入职责参考](../../../docs/reference/device-access-code-reference.md) 第 10、11 节为契约，使用 Vitest 的 Node 环境。无需浏览器、数据库、米家账号或 go2rtc。

| 测试文件               | 行为边界                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `subscription.test.ts` | 真实 SSE 字节解析、UTF-8 分片、快照基线、原子增量、版本与家庭隔离、响应头和失联期限、Retry-After、重连与清理。 |
| `state.test.ts`        | 真实 Jotai store 的命令串行与版本确认、验证码取消、自动登录去重与清理门、错误恢复、播放资格及设备筛选。        |
| `api.test.ts`          | 真实 Hono RPC 客户端的验证期限、镜头预约、SDP 幂等重试、取消和 viewer keepalive 释放。                         |

`support/household.ts` 提供共享 schema 校验的最小公共状态，`support/http.ts` 提供可记录请求、可取消的真实响应流与可控时钟。默认 fetch 拒绝未配置请求，避免访问外部服务。每个状态用例重新创建模块级 store 和私有 atom；清理恢复全局替身和时钟，订阅用例显式关闭连接。

失败用例保留正常断言，用于暴露实现与契约的差异，不使用 skip、todo 或 expected-failure 隐藏。用例按业务风险选取，不以代码覆盖率为完成条件。

这里不渲染 React 组件，不测试 DOM、布局、视频首帧、WebRTC 浏览器能力或实机媒体链路。HTTP 和 SSE 模拟结果不能证明米家云协议、真实 MQTT 或摄像头验收通过。
