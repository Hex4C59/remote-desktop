# 项目文档

本目录按用途组织文档。项目概览见 [仓库 README](../README.md)，源码位置见 [应用源码说明](../apps/README.md)。

```text
docs/
  README.md       文档导航
  guides/         开发环境、构建与联调说明
  design/         项目范围、技术选型与协议设计
  adr/            架构决策记录
  validation/     历史验证记录
    evidence/     结构化验证证据
  agents/         Agent 工作约定
```

## 阅读入口

- 了解项目目标：先读 [项目范围与访谈](design/project-brief.md) 和 [领域术语](../CONTEXT.md)。
- 构建与联调：读 [WebRTC 构建与文件联调](guides/webrtc-probes.md)，正常连接流程见 [配对协议](design/pairing-protocol.md)。
- 理解实现：读下方设计文档和 ADR。
- 核对验证结果：读 `validation/` 的任务记录及对应证据。
- 查看待办与验收要求：读 [当前规格](../.scratch/lan-remote-desktop-mvp/spec.md) 和 [任务目录](../.scratch/lan-remote-desktop-mvp/issues/)；`.scratch/` 保存需求与任务，`validation/` 保存实际验证结果。

环境文档与验证记录保留各自的核查时间、版本和限制；目录迁移不代表当前源码重新通过构建或运行验证。

## 开发与运行指南

| 文档 | 内容 |
| --- | --- |
| [WebRTC 构建与文件联调](guides/webrtc-probes.md) | 固定依赖、两端构建、合成视频与真实桌面联调入口 |
| [开发环境核查](guides/development-environment.md) | 初始 Ubuntu 开发环境与后续环境准备记录 |
| [Windows 开发环境核查](guides/windows-environment.md) | Windows 工具链与桌面访问核查 |
| [首阶段环境准备参考](guides/bootstrap-references.md) | 工具安装、远程访问和设备调试参考 |

## 范围与技术设计

| 文档 | 内容 |
| --- | --- |
| [项目架构：概览与组件](design/project-architecture.md) | 四平台全景、现有链路与待设计扩展；含交互图 |
| [项目范围与访谈](design/project-brief.md) | 场景、目标岗位、平台与第一阶段范围 |
| [技术路线调研](design/technical-options.md) | 媒体及传输路线对比 |
| [WebRTC 固定构建版本](design/webrtc-build-candidate.json) | 构建脚本读取的依赖版本和工具链要求 |
| [WebRTC 原型 API 笔记](design/webrtc-prototype-api-notes.md) | 固定版本 API 与接入边界 |
| [配对与信令协议](design/pairing-protocol.md) | 地址、临时口令、认证与会话建立 |
| [触屏定位与点击](design/pointer-input.md) | 坐标映射、鼠标消息与复现方式 |
| [字符与终端按键](design/terminal-input.md) | 文本、按键和组合键输入语义 |

## 架构决策

- [ADR 0001：第一版聚焦局域网](adr/0001-lan-video-first.md)。
- [ADR 0002：自己组织视频链路，复用基础设施](adr/0002-own-video-pipeline-orchestration.md)。
- [ADR 0003：优先验证原生 libwebrtc](adr/0003-validate-native-libwebrtc-first.md)。

## 验证记录与证据

| 记录 | 对应证据 |
| --- | --- |
| [第一阶段：环境与连通性](validation/phase-one-status.md) | [互通摘要](validation/evidence/interop-smoke.json) |
| [任务01：真实桌面视频](validation/task01-desktop-video.md) | [证据](validation/evidence/task01-desktop-video.json) |
| [任务02：地址与临时口令配对](validation/task02-pairing.md) | [证据](validation/evidence/task02-pairing.json) |
| [任务03：触屏定位与点击](validation/task03-touch-pointer.md) | [证据](validation/evidence/task03-touch-pointer.json) |
| [任务04：字符与终端按键](validation/task04-terminal-input.md) | [证据](validation/evidence/task04-terminal-input.json) |
| [任务05：结束会话与手动重连](validation/task05-session-reconnect.md) | [证据](validation/evidence/task05-session-reconnect.json) |
| [任务06：视频统计](validation/task06-video-statistics.md) | [证据](validation/evidence/task06-video-statistics.json) |
| [任务07：软件测量完成](validation/task07-end-to-end-latency.md) | 用户授权AI视觉复核，20次有效；人工复核0，物理测量延期 |
| [任务08：十分钟局域网基线](validation/task08-lan-baseline.md) | 采集完成，18次有效、2次边界缺口；720p30目标未达 |
| [授权视觉复核与逐项边界](validation/task07-authorized-visual-review.md) | 40次正式边界均由同一AI判读并复读，保留哈希、区间和失败 |

历史验证所用提交编号的对应关系见 [Git 提交映射](validation/git-history.md)。

## Agent 工作约定

- [规格与任务管理](agents/issue-tracker.md)。
- [分诊标签](agents/triage-labels.md)。
- [领域文档与术语约定](agents/domain.md)。

软件性能采集：[软件测量与反馈帧复核](guides/software-measurement.md)、[十分钟局域网基线](guides/lan-baseline.md)。当前实施与验收边界见[任务07记录](validation/task07-end-to-end-latency.md)和[任务08记录](validation/task08-lan-baseline.md)。
