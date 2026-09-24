## Agent skills

### 技能入口

根据用户请求所处阶段，主动读取下表对应的 `SKILL.md` 后执行，用户无需重复提醒技能名称。技能未显示在当前会话列表时，按本地链接读取；具体步骤以技能正文为准。

| 请求或阶段 | 读取的技能 |
| --- | --- |
| 讨论新功能或重大方案，目标、范围或关键选择尚未明确 | [grilling](.agents/skills/grilling/SKILL.md) |
| 澄清领域术语，或记录重要架构取舍 | [domain-modeling](.agents/skills/domain-modeling/SKILL.md) |
| 将已讨论的内容形成规格 | [to-spec](.agents/skills/to-spec/SKILL.md) |
| 将规格或计划拆成有依赖关系的任务 | [to-tickets](.agents/skills/to-tickets/SKILL.md) |
| 按规格或编号任务实施 | [implement](.agents/skills/implement/SKILL.md) |
| 绘制项目架构、流程、时序或状态图 | [archify](.agents/skills/archify/SKILL.md) |
| 审查变更，包括实施完成后的审查 | [code-review](.agents/skills/code-review/SKILL.md) |
| 诊断故障或性能退化 | [diagnosing-bugs](.agents/skills/diagnosing-bugs/SKILL.md) |
| 要求技术调研并保存有来源的结论 | [research](.agents/skills/research/SKILL.md) |
| 要求测试先行或 red-green-refactor | [tdd](.agents/skills/tdd/SKILL.md) |
| 创建或修改技能、`AGENTS.md`、`CLAUDE.md` | [writing-for-agents](.agents/skills/writing-for-agents/SKILL.md) |

已有明确规格或任务时，从对应阶段继续；常规小改动直接实施并执行适合该改动的检查。讨论形成的术语和架构取舍按 `domain-modeling` 的条件记录。

### Issue tracker

规格与任务使用本地 Markdown；创建、读取或更新时先读 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五个分类标签；分诊或设置任务状态时先读 `docs/agents/triage-labels.md`。

### Domain docs

采用 single-context 布局；探索代码或编写规格前，按 `docs/agents/domain.md` 读取术语和相关 ADR。
