# 项目文档

| 要查什么 | 入口 |
| --- | --- |
| 项目目标、构建命令和测试入口 | [项目说明](../README.md) |
| 开发约束、规格审批与 TDD | [协作规则](../AGENTS.md) |
| 怎样把文档写得让读者看懂 | [文档写作示例](writing-guide.md) |
| 系统分层、模块职责、关键决策和里程碑 | [架构总览](architecture/overview.md) |
| 线程职责、跨线程交接、队列和延迟预算 | [线程模型](architecture/threading.md) |
| 怎样调用屏幕采集、输入注入、会话状态和渲染接口，以及会返回什么 | [平台抽象](architecture/platform-abstraction.md) |
| 控制消息、配对、会话和线缆格式 | [控制协议 v1](protocol/README.md) · [测试向量](protocol/vectors/envelope.json) |
| 各项功能的规格、方案、任务和审批状态 | [增量索引](increments/README.md) |
| 按改动选测试、对照验收编号和记录结果 | [测试与验收](verification/README.md) |
| 新增量的规格、方案和任务模板 | [规格模板](templates/spec.template.md) · [方案模板](templates/plan.template.md) · [任务模板](templates/tasks.template.md) |
| 第三方产品观察 | [参考资料](references/README.md) |

开发新功能时，从增量索引查阅对应的规格、方案和任务。涉及模块依赖、线程职责或公共接口时，同时查阅相应的架构文档。修改控制消息时，按协议正文同步测试向量。
