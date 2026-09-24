# 项目架构与阶段边界

本项目使用两张独立 HTML 架构图，分别说明全局范围和当前软件组件；两者均可查看源码引用、切换明暗主题和导出。

- [系统概览与扩展规划](../../.archify/architecture-remote-desktop-revised-20261010-175259/remote-desktop-overview.html)：覆盖 Android、Windows、macOS、Linux 及远期公网目标。实线表示已有运行链路，虚线只表示后续规划。
- [已实现的软件组件架构](../../.archify/architecture-remote-desktop-components-20261010-175259/remote-desktop-components.html)：按 Android 控制端应用与 Windows 被控端程序分组，展开配对、媒体、显示与采集、输入和统计职责。

概览中的“配对”代表两端应用内部的协作逻辑；“Windows 本地日志”是被控端写入的 JSONL 文件。它们不代表独立配对服务、数据库或统计服务。

## 平台职责

| 平台 | 当前职责 | 状态 |
| --- | --- | --- |
| Android | 控制端：配对、视频显示、触屏与键盘输入、接收统计 | 已有实现，源码位于 `apps/android/` |
| Windows | 被控端：配对认证、桌面采集与视频发送、输入执行、统计日志 | 已有实现，源码位于 `apps/windows/` |
| macOS | 计划支持的桌面端；控制端、被控端或双角色尚未确定 | `apps/macos/` 为预留目录 |
| Linux | 计划支持的桌面端；控制端、被控端或双角色尚未确定 | `apps/linux/` 为预留目录 |

## 当前运行链路

1. 用户在 Android 输入 Windows 地址与当次配对口令，通过 TLS 完成认证与信令交换。
2. 认证成功后，Windows 创建桌面帧源与 WebRTC 会话，采集、转换和缩放桌面视频，Android 接收并显示。
3. Android 通过授权会话的 DataChannel 回传触屏、文字和终端按键；Windows 校验并执行。
4. Android 采集视频统计，经同一 DataChannel 发送给 Windows；Windows 写入会话 JSONL，并返回保存回执。
5. 断网、离开前台或主动结束会话时清理媒体和输入状态；手动重连建立新会话。

模块设计依据见 [配对与信令](pairing-protocol.md)、[触屏输入](pointer-input.md)、[终端按键](terminal-input.md)；已完成验证的具体范围见 [任务05](../validation/task05-session-reconnect.md) 和 [任务06](../validation/task06-video-statistics.md)。

## 已实现的组件职责

| 职责 | Android 控制端 | Windows 被控端 |
| --- | --- | --- |
| 配对与信令 | `PairingConnection` 建立证书固定的 TLS 连接；`ProbeActivity` 处理授权及 SDP/ICE | `PairingServer` 校验配对口令、管理单会话及信令；授权后启动桌面会话 |
| 媒体接入 | 项目代码接入 libwebrtc 的 PeerConnection、视频解码和 DataChannel | `Sender` 接入 libwebrtc 的媒体工厂、视频轨道和 DataChannel |
| 画面 | WebRTC 视频轨道绑定 `SurfaceViewRenderer`；UI 处理显示与输入坐标 | `DesktopSource` 用 DXGI 采集，复用 libyuv 完成 I420 转换、旋转和缩放，再提交媒体帧 |
| 输入 | 触屏、文字和终端按键经授权会话发送，并限制排队 | 接收及执行时复查授权和结束状态；`PointerInput`、`KeyboardInput` 调用 Windows `SendInput` |
| 统计 | 调用 `getStats`、采样及显示状态，并接收保存回执 | `VideoStatisticsLog` 校验样本，写入工作目录的 JSONL 文件，刷新后回传 `stats-saved` |

组件图中的节点是逻辑职责，不代表独立进程或已经抽出的公共模块。输入、统计及其回执的横向箭头表示业务消息，均复用媒体接入层的同一 DataChannel；它们不是绕过 libwebrtc 的新传输通道。

项目负责上述编排、平台适配与会话状态，libwebrtc 提供媒体和传输基础设施，libyuv 提供图像转换能力。图不承诺特定编解码器或硬件加速。日志刷新回执也不等同于持久介质落盘保证。

## 后续规划

- macOS、Linux 的端角色、采集与输入适配、UI 和公共代码边界仍待设计。图中的“多平台扩展规划”是规划位置，不是已有公共运行库，也不预设各平台使用同一套实现。
- 公网连接是远期目标。穿透、中转和连接协调服务尚未选型，图没有承诺某种服务器或部署拓扑。
- 下一阶段先推进 [任务07](../../.scratch/lan-remote-desktop-mvp/issues/07-end-to-end-latency.md) 的软件测量，再建立十分钟基线、做弱网实验和优化对照。720p30 是验证目标；物理画面显示延迟和操作反馈延迟保持延期、未验收。

上述规划不改变 [当前 MVP 规格](../../.scratch/lan-remote-desktop-mvp/spec.md) 的 Android → Windows 首版边界，也不替代新的平台设计与任务拆分。

## 图的源码证据

交互图的源码引用固定在提交 `f08a12898a0dcfee4942cd4270d2db6591403371`，所以引用路径仍使用该提交中的 `probes/webrtc/` 和旧文档目录。当前工作区已迁入 `apps/` 的应用源码内容与迁移前一致，目录整理尚未提交。

macOS、Linux 的预留状态来自当前工作区和本次讨论；旧规格的引用用于说明它们尚未纳入首版，而不作为已经实现的平台证据。新的软件测量计划也不能从旧提交推导为已实现功能。

两张图的定义与检查记录分别保留：

- 概览：[可编辑定义](../../.archify/architecture-remote-desktop-revised-20261010-175259/candidate.json)、[自动检查与哈希](../../.archify/architecture-remote-desktop-revised-20261010-175259/review-2/remote-desktop-overview.finalize-summary.json)。
- 组件：[可编辑定义](../../.archify/architecture-remote-desktop-components-20261010-175259/candidate.json)、[自动检查与哈希](../../.archify/architecture-remote-desktop-components-20261010-175259/review-2/remote-desktop-components.finalize-summary.json)。

旧版图与检查记录保留在原目录，当前文档入口指向上述修订版。
