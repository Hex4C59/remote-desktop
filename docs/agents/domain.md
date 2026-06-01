# Domain Docs

## 阅读入口

本仓库采用 single-context 布局。探索代码或编写规格前，读取根目录 `CONTEXT.md`；涉及架构或实现决策时，读取 `docs/adr/` 中与当前工作相关的 ADR。

若文档不存在，继续工作即可。术语和决策明确后，由 domain-modeling 按需记录。

## 文件布局

- `CONTEXT.md`：项目领域术语。
- `docs/adr/`：项目架构决策记录。

## 使用术语

规格、任务标题、测试名称及设计说明使用 `CONTEXT.md` 定义的词汇，遵循其中的 Avoid 约定。需要的新概念尚无定义时，先核对已有概念；确有缺口时交由 domain-modeling 补充。

## ADR 冲突

方案与现有 ADR 冲突时，明确指出 ADR 编号、冲突内容及建议重新讨论的原因，再决定是否修订原决策。
