# 家庭运行时功能测试

行为依据为[家庭运行时：功能与业务行为](../../../../docs/contracts/household-runtime.md)。先用规则确定前提、外部事实和应有结果，再选择真实业务入口；规格实现、状态机节点布局、内部引用和覆盖率不是功能断言的来源。

## 运行

在仓库根目录按改动选择直接相关的文件；新增测试须先取得用户明确许可：

```sh
bun test ./apps/backend/tests/household/lifecycle.test.ts
bun test ./apps/backend/tests/household/device-reports.test.ts
bun test ./apps/backend/tests/integration/runtime-authorization.test.ts
bun run --cwd apps/web test -- tests/integration/command-confirmation.test.ts
```

后端使用 Bun，Web 业务逻辑使用 Vitest Node 环境。无需真实米家账号、摄像头或外部网络；后端媒体替身需要监听本机随机端口。测试复用 `tests/support/household-harness.ts` 的真实账号、家庭、设备、规格与读取对象，仅替换供应商和存储边界。异步交错通过可释放的 Promise 等待点控制，公开时间策略使用假时钟。

## 行为与证据

下表把组合场景与已有单项验证放在一起；文件名是可运行测试的入口，不表示所有规则都由单个文件独立证明。

| 业务风险                                     | 规则                                                                                          | 主要测试与可观察证据                                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首次设置出现多个候选或并发选择               | BND-02/03/04/06                                                                               | `../integration/runtime-authorization.test.ts`、`lifecycle.test.ts`：保存确认前拒绝读取、观察和播放；最终公共家庭、可读设备与唯一持久绑定一致；允许任一并发请求胜出。                                                                                                                                         |
| 保存提交后回执延迟、停止与重启               | BND-01/07、RUN-02/09/10、SC-19                                                                | `../integration/runtime-authorization.test.ts`：已保存绑定保留，旧回调不能恢复停止的运行；重启产生新标识并等待本轮完整清单。`transaction-outcome.test.ts` 另验证不确定提交的核对与禁止盲写。                                                                                                                  |
| 启动缓存、首轮失败、退出及家庭失权           | RUN-02 至 RUN-08、DIR-01/02/06/07                                                             | `lifecycle.test.ts`、`../integration/household-reads.test.ts`、`../integration/account-lifecycle.test.ts`：缓存不能授权；普通请求失败、单设备缺详情、全家庭失权和账号失效分别检查影响范围。                                                                                                                   |
| 凭据删除失败，重新同步先失败后成功           | RUN-08/10、BND-08、SC-14                                                                      | `../integration/runtime-authorization.test.ts`：绑定保留，恢复前不可读；旧读取、观察及播放资格均不能复活，新任务按新确认结果判断。契约不满足时保留普通失败断言。                                                                                                                                              |
| 完整清单确认撤销，但新增资料超限             | DIR-04/09、RUN-10、SC-09                                                                      | `directory-behavior.test.ts`：数量和 UTF-8 字节分别超限；旧读取取消、移除设备和新增设备均不能读、同伴仍能读；恢复后才接纳新范围。不限定错误期间旧展示条目的保留方式。                                                                                                                                         |
| 无页面时刷新交错，HTTP 回执早于工作完成      | REF-03 至 REF-06                                                                              | `directory-behavior.test.ts`：真实 Hono 路由接纳刷新，云请求与规格任务仍可等待；突发请求不堆积无界云工作，所需后续清单和规格结果均可交付；状态、诊断和候选读取不增加云请求。                                                                                                                                  |
| 周期发现、通知与供应商退避                   | REF-01/02/04                                                                                  | `../mijia/devices/discovery.test.ts`、`../mijia/observations/directory-notifications.test.ts`：公开周期、通知合并、权威完整同步、取消与重试期限。                                                                                                                                                             |
| 换房更新与订阅初始化交错                     | DIR-03、PUB-01/02、WEB-01、SC-16                                                              | `directory-behavior.test.ts`：保存等待期间建立真实 SSE；房间删除、新房间和设备归属在同批发布，版本连续；来源对象随后变化不能静默改写公共状态。                                                                                                                                                                |
| 慢页面与正常页面并存                         | WEB-08、SC-18                                                                                 | `directory-behavior.test.ts`、`../mijia/http/routes.test.ts`：真实响应流的队列字节超限、连接名额和写入期限；慢连接被回收，正常连接持续收取，重连取得当前快照，后台资格不变。                                                                                                                                  |
| 仅型号或仅 URN 改变，另有缓存故障            | DIR-05/08、SPC-05/07、SC-10/20                                                                | `specifications/behavior.test.ts`：通过真实读取和观察核对定义适用性；同伴继续可用，存储恢复不能清除规格故障或授予旧能力。                                                                                                                                                                                     |
| 共享规格、刷新失败及最后引用消失             | DIR-13、SPC-02/04/08、SC-11                                                                   | `specifications/behavior.test.ts`、`specifications/owner.test.ts`：不重复下载适用的共享规格；增减设备不打断同伴；同定义刷新失败仍可读，仅写属性仍拒读；最后引用移除后取消在途任务，迟到成功不能复活设备。                                                                                                     |
| 规格并发、重试及容量                         | SPC-03/06、[运行限额](../../../../docs/contracts/household-runtime.md#当前数量大小与时间边界) | `specifications/owner.test.ts`、`capacity.test.ts`：并发和重试有界，失败不阻塞其他任务，容量不阻止任务终态与访问撤销。                                                                                                                                                                                        |
| 页面收到非法或不连续批次、退出回执与重连交错 | PUB-01、WEB-01 至 WEB-05、SC-16/17                                                            | [Web 订阅测试](../../../web/tests/modules/household/subscription.test.ts) 验证整批拒收与快照恢复；[命令确认测试](../../../web/tests/integration/command-confirmation.test.ts) 验证 HTTP 结束前的旧快照不能解除播放暂停，之后按已确认家庭状态判断资格。                                                        |
| 页面重连、筛选和状态隔离                     | PUB-03/04/05、WEB-06/07                                                                       | `../../../web/tests/modules/household/subscription.test.ts`、`../../../web/tests/modules/mijia/commands.test.ts`、`../../../web/tests/pages/devices/filters.test.ts` 及后端 HTTP 测试：版本确认、重试期限、公开字段和前端筛选。共享规则由 `../../../../packages/api/tests/contracts/household.test.ts` 验证。 |

## 判定边界

成功证据应组合公共状态、可靠保存的事实、实际任务接纳或拒绝、旧结果是否交付以及独立消费者状态。不能仅以 HTTP 成功、`running` 或页面出现设备判定授权成立。规格摘要允许保留时，不把保留某个摘要字段写成强制要求；实际读取适用性单独验证。SSE 的业务单位是完整事件批次，不假设传输块与事件一一对应，也不固定中间事件数量。

这些测试不渲染 React UI，不验证真实数据库锁等待、连接池释放、JSONB 增量 SQL 的实际执行或操作系统异常退出。存储替身与事务协议测试只能证明相应边界约定，不能替代真实 PostgreSQL 的提交、回滚和恢复验收。增量数据库写入与真实摄像头、供应商认证/限流等仍需对应集成或实机证据；没有把测试替身的通过结果标记为这些验收已完成。

`device-reports.test.ts` 依据[设备事实](../../../../docs/contracts/device-facts.md)和[房间 AI 上下文](../../../../docs/contracts/room-analysis.md)，验证缺值与关闭的区别、云缓存不覆盖实时值或延长其有效期、同值续报不制造变化、断连与到期撤销使用资格、恢复首报不推断缺口期间的变化、积压超期报告不复活状态，以及未配置策略、规格未知和非法报告的使用限制。通过真实家庭状态机提交报告，并检查房间查询、可信变化和模型输入；单调时间可控，不等待真实计时器。

首次授权没有候选家庭的具体交互、损坏数据库记录的自动修复，以及文档未规定的错误码，不在这里补造产品约定。设备报告测试不验证持续采集与补读调度、历史保存、规则动作执行、Agent 自动调用或模型回答；实机来源保证仍需独立验收。
