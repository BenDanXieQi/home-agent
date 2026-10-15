# 家庭运行时功能测试

行为依据为[家庭运行时：功能与业务行为](../../../../docs/contracts/household-runtime.md)。先用规则确定前提、外部事实和应有结果，再选择真实业务入口；规格实现、状态机节点布局、内部引用和覆盖率不是功能断言的来源。

## 运行

在仓库根目录按改动选择直接相关的文件；新增测试须先取得用户明确许可：

```sh
bun test ./apps/backend/tests/household/lifecycle.test.ts
bun test ./apps/backend/tests/household/device-reports.test.ts
bun test ./apps/backend/tests/integration/device-online.test.ts
bun test ./apps/backend/tests/integration/runtime-authorization.test.ts
bun run --cwd apps/web test -- tests/integration/command-confirmation.test.ts
```

## 行为与证据

下表把组合场景与已有单项验证放在一起；文件名是可运行测试的入口，不表示所有规则都由单个文件独立证明。

## 判定边界

成功证据应组合公共状态、可靠保存的事实、实际任务接纳或拒绝、旧结果是否交付以及独立消费者状态。不能仅以 HTTP 成功、`running` 或页面出现设备判定授权成立。规格摘要允许保留时，不把保留某个摘要字段写成强制要求；实际读取适用性单独验证。SSE 的业务单位是完整事件批次，不假设传输块与事件一一对应，也不固定中间事件数量。

这些测试不渲染 React UI，不验证真实数据库锁等待、连接池释放、JSONB 增量 SQL 的实际执行或操作系统异常退出。存储替身与事务协议测试只能证明相应边界约定，不能替代真实 PostgreSQL 的提交、回滚和恢复验收。增量数据库写入与真实摄像头、供应商认证/限流等仍需对应集成或实机证据；没有把测试替身的通过结果标记为这些验收已完成。

首次授权没有候选家庭的具体交互、损坏数据库记录的自动修复，以及文档未规定的错误码，不在这里补造产品约定。设备报告测试不验证持续采集与补读调度、历史保存、规则动作执行、Agent 自动调用或模型回答；实机来源保证仍需独立验收。
