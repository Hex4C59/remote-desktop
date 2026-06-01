# Triage Labels

| 标准角色 | 本仓库标签 | 含义 |
| --- | --- | --- |
| needs-triage | needs-triage | 等待维护者评估 |
| needs-info | needs-info | 等待补充信息 |
| ready-for-agent | ready-for-agent | 规格明确，可由 Agent 执行 |
| ready-for-human | ready-for-human | 需要人工实现 |
| wontfix | wontfix | 不予实施 |

技能提及分类角色时，使用表中的同名标签。本地规格和任务通过顶部的 `Status: <标签>` 行记录分类；例如 to-spec 发布的规格使用 `Status: ready-for-agent`。

这五个标签用于分诊，不表示实现已经完成。Wayfinder 的执行状态遵循 `issue-tracker.md` 的独立约定。
