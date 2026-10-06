# Web 业务逻辑测试

测试只验证 Web 自己负责的业务决策、请求和状态协调，不渲染 React 组件，不断言 HTML、按钮属性、文案、布局或动效。后端负责的设备清单生成、账号授权、供应商协议和媒体资源规则由后端测试验证；共享数据校验和增量合并规则由 `packages/api/tests/contracts/household.test.ts` 验证。

## 运行

在仓库根目录安装依赖后，按改动选择具体文件：

```sh
bun run --cwd apps/web test -- tests/modules/mijia/commands.test.ts
bun run --cwd apps/web test -- tests/modules/household/subscription.test.ts tests/integration/command-confirmation.test.ts
```

测试使用 Vitest Node 环境，无需浏览器、数据库、米家账号或 go2rtc。用例按前端业务风险选取，不以覆盖率或与源码文件数量一致为目标。

## 文件归属

`tests/modules/` 和 `tests/pages/` 按 `src/` 中业务逻辑的位置组织，文件名对应被测模块。页面目录内只测试筛选等业务计算，不测试组件。`integration/` 仅保留需要多个前端模块协作才能验证的时序。

| 测试文件                                   | 责任边界                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `modules/household/subscription.test.ts`   | SSE（服务端事件流）的字节接收、整批发布、异常批次拒收、版本与家庭隔离、超时、重连期限和连接清理。 |
| `modules/mijia/commands.test.ts`           | 请求串行、取消验证、迟到响应隔离、HTTP 结果与状态版本确认、错误恢复。                             |
| `modules/mijia/login.test.ts`              | 自动登录去重、失败后不自动循环、旧媒体清理期间阻止自动登录。                                      |
| `modules/mijia/api.test.ts`                | 人工验证请求使用独立期限并能超时取消。                                                            |
| `modules/playback/access.test.ts`          | 短暂断流、退出结果不确定和缓存恢复时的播放资格。                                                  |
| `modules/devices/state.test.ts`            | 无关公共状态变化不重建设备数组或通知设备订阅者。                                                  |
| `modules/device-logs/state.test.ts`        | 家庭与采集批次隔离、日志累积上限、重复命令抑制、结果确认和旧请求隔离。                            |
| `pages/devices/filters.test.ts`            | 搜索、组合筛选、未知分类和切换家庭后的筛选重置。                                                  |
| `integration/command-confirmation.test.ts` | 真实 HTTP 客户端和 SSE 接收之间的退出确认时序，以及确认后的播放资格。                             |

## 测试辅助与断言边界

`support/household.ts` 只提供符合共享 schema 的设备清单样本和命令回执。测试直接导入所属业务模块，并为状态用例创建独立的 Jotai store（状态容器），不合并模块导出，也不依靠重载整个模块图清空状态。

`support/http.ts` 提供可记录请求的 fetch 替身、可取消的真实响应流与可控时钟。默认拒绝未配置请求，避免访问外部服务；清理恢复全局替身和时钟，订阅用例显式关闭连接。

同一业务场景可以在两端分别验证不同责任：后端证明重复信令不会重复创建资源，前端证明响应丢失时沿用原参数重试；后端证明变更作为整批发布，前端证明接收时不暴露半批状态。前端不重复枚举共享 schema 的字段校验规则，只验证拒收非法数据后的状态与恢复行为。

HTTP 和 SSE 模拟结果不能证明真实米家协议、摄像头出帧或浏览器媒体行为通过验收。

`modules/spatial/commands.test.ts` 覆盖响应丢失后对已提交、未变化、其他写入及家庭切换结果的区分，并验证 HTTP 409 的引用结果与版本错误分别解码。

```sh
bun run --cwd apps/web test -- tests/modules/spatial/commands.test.ts
```
