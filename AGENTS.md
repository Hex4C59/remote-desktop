# remote-desktop（从零重写）

2026-11-09 应用户要求清空了 M0 原型的全部代码与文档，准备从零手写。
本文件只保留仍然有效的约定；旧版约定见 Git 历史（`git show archive/m0-prototype:AGENTS.md`）。

## 旧代码与证据去向

- 全部已提交内容保留在 Git 历史与标签 `archive/m0-prototype`（commit 362a884，已推送 origin/master）。
- 未提交的本地证据（十分钟基线、真机测试日志、APK、构建产物）已移到
  `D:\Projects\Archive\remote-desktop-m0-evidence-20261109\`（build/ 约 1.3G、.local/ 约 8.4M）。
- 旧架构设计见 `git show archive/m0-prototype:ARCHITECTURE.md`；
  旧 README、构建脚本、探针、测量工具同样从该标签取回。
- libwebrtc 源码与 depot_tools 在仓库外，未受本次清空影响；固定版本记录在
  `git show archive/m0-prototype:scripts/webrtc/webrtc-build-candidate.json`。

## 仍然有效的边界

- 删除或改写看起来是有意为之的功能、代码或验证记录前，先问用户。
- 桌面采集只在已登录、未锁屏的交互会话有效；SSH Session 0 的结果不能当作桌面能力证据。
- 构建通过不代表真机链路可用，也不构成性能结论；软件耗时、操作到反馈帧耗时与物理画面延迟是不同指标。
- SDP、配对口令、截图、原始测量证据和主机信息不得提交。
- 注释用直白中文讲清"为什么"；单行建议 80–100 字符，最多 120。
- 不写用户没要求的防御性代码和兼容层：入口校验一次，内部不重复校验，不吞异常，不留未使用分支。

## 提交

准备提交、整理暂存或编写提交信息时，按 [git-commit](.agents/skills/git-commit/SKILL.md) 执行。