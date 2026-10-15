# Web 业务逻辑测试

## 运行

在仓库根目录安装依赖后，按改动选择具体文件：

```sh
bun run --cwd apps/web test -- tests/modules/mijia/commands.test.ts
bun run --cwd apps/web test -- tests/modules/household/subscription.test.ts tests/integration/command-confirmation.test.ts
```

测试使用 Vitest Node 环境，无需浏览器、数据库、米家账号或 go2rtc。用例按前端业务风险选取，不以覆盖率或与源码文件数量一致为目标。

## 测试辅助与断言边界

同一业务场景可以在两端分别验证不同责任：后端证明重复信令不会重复创建资源，前端证明响应丢失时沿用原参数重试；后端证明变更作为整批发布，前端证明接收时不暴露半批状态。前端不重复枚举共享 schema 的字段校验规则，只验证拒收非法数据后的状态与恢复行为。

HTTP 和 SSE 模拟结果不能证明真实米家协议、摄像头出帧或浏览器媒体行为通过验收。
