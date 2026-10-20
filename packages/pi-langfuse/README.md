# Pi Durable 观测适配

本包提供 Pi Durable 会话事件观察器。调用方提供追踪后端并负责释放观察器和共享运行时；本项目通过[共享观测包](../observability/README.md)接入。

实现取自 [`@narumitw/pi-langfuse@0.52.0`](https://github.com/narumiruna/pi-extensions/tree/366c62e05394371379ec1283fdcefb5f518ceede/packages/pi-langfuse) 的 Durable 部分，固定来源提交为 `366c62e05394371379ec1283fdcefb5f518ceede`。原作者为 narumiruna，授权见 [LICENSE](LICENSE)。工作区保留事件观察、内容投影、共享运行时和后端契约，并按当前 Pi API 处理嵌套工具结果、父工具关系及异常观察器关闭。

## 内容与边界

内容采集由调用方控制，使用时明确设置 `captureContent`。观测数据可能包含消息、工具参数及错误详情。

观察器不重建遗漏的历史执行或跨进程追踪；记录不完整不等于业务执行失败。停止观察不负责取消业务任务。

接口以[源码](src)为准，依赖升级与替换原则见[观测维护决策](../../docs/agent/observability-maintenance.md)。
