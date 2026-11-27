# 001 任务清单 · Android 手机在局域网远控 Windows 电脑

## 依据

[001 规格](spec.md) · [M1 方案](plan.md)。按方案中的波次检查点推进，先为各项功能编写规格、方案和任务清单，再提交评审。各行为任务记录失败断言、最小实现后的目标用例结果和 Debug 全量回归结果。

## 波次 1 · 平台与测试准备

- [ ] T001 核对 [001 规格](spec.md) 的审批记录，评审 [007 Android 控制端](../007-android-controller/spec.md) 规格、方案及任务，记录已批准的 [003 Windows 平台](../003-platform-win/spec.md) 和 [005 桌面状态](../005-windows-desktop-state/spec.md) 作为被控端前置（路径 `docs/increments/`、`docs/architecture/`。验证 `spec.structure` 和审批状态。）
  - 001 的 Android 修订已获批，007 待评审。
- [ ] T002 按 [003 任务](../003-platform-win/tasks.md) 和 [005 波次 1](../005-windows-desktop-state/tasks.md) 验证平台能力和关断前置条件（路径 `src/platform/win/`、`tests/unit/platform/win/`。先以 mock 记录 PW-18、PW-21、DS-01–03、DS-06 观察器断言的红灯，再验证平台实现。M1U-30 的完整门禁交错由 T006 验证。）
  - 003 的 PW-18、PW-21 和 005 的 DS-01–03、DS-06 观察器断言已完成 mock 红绿循环，证据 `test-results/m1-t002.md`。005 T004 的原生桌面事件源证据见 `test-results/005-t004.md`。先前候选的 PWH-02–06（含实际锁屏/解锁）记录保留在 `test-results/platform-win/t006-readback.md`。
  - 2026-11-27 按已批准的新预算复验：三次 60 秒及连续 600 秒的内存均达标，但第二次 60 秒和 600 秒存在像素断言失败，PWH-04/05 的光标位置断言失败，PWH-08 缺少 duplication 的 SDK 在用报告。PWH-02、实际锁屏/解锁的 PWH-03 及 Debug 95/95、Release 96/96 已通过；尚不能关闭平台前置。完整原始记录与构建散列见 `test-results/platform-win/t006-budget-revision.md`。
  - 2026-11-28 同一最终构建复验：PWH-01/06 三进程 3/3、PWH-04/05 通过；PWH-07、PWH-08 及最终构建上的 PWH-02/03 仍待执行，平台前置保持开放。

## 波次 2 · 安全连接、本机授权与仅查看

- [ ] T003 定稿安全传输与会话授权功能规格，明确握手、通道绑定、错误返回和有效暂停的有序入槽规则（路径 `docs/increments/`、`docs/protocol/`。验证配对与远控全流程及消息向量一致。）
- [ ] T004 按获批契约实现认证、配对与本机授权（路径 `src/transport/`、`src/session/`、`src/app/`、`tests/unit/`。验证错误身份、串用连接、批准前拒绝或超时及 M1U-19 的持久化分支。）
  - M1U-19 用 mock Writer 分别安排取消先于许可、许可先于取消、写入失败和两端提交之间断线。断言各端持久化记录、界面结果、迟到结果和同身份重新配对。

- [ ] T007 定稿媒体链路规格并接入 Windows 采集、编码及 [007 Android 呈现](../007-android-controller/spec.md)（路径 `src/capture/`、`src/codec/`、`src/app/`、`src/platform/android/`、`tests/integration/`。验证 `media.offer` 映射绑定、旧帧隔离和首帧确认。）
  - T003–T004 及 Windows 原生采集就绪后，用真实配对、授权和视频链路建立仅 `view` 会话。Windows 客户端渲染另见 [006](../006-windows-render-surface/spec.md)。
  - M1U-06 分别触发媒体拒绝、断线和模拟时钟上的首帧超时。延迟退出确认，验证第二端先收到 `kBusy`，确认后方可申请授权。

## 波次 3 · 输入与会话生命周期

- [ ] T005 定稿输入与线程关断功能规格和测试路径（路径 `docs/increments/`、`docs/architecture/threading.md`。定义暂停保留槽、门禁封闭与许可的原子顺序、部分注入失败的关断及释放确认。）
- [ ] T006 按获批契约实现输入代次、门禁关断和清理（路径 `src/transport/`、`src/input/`、`src/session/`、`tests/unit/`、`tests/integration/`。验证输入边界、释放受阻、映射变化和迟到回调，并覆盖下列并发用例。）
  - M1U-22 注入器分别报告部分成功、释放失败和效果不确定，并预置后续输入。断言按压记录、后续平台调用次数、`kEnding` 和清理确认前的 `kBusy`。
  - M1U-29 填满普通接收队列，验证有效暂停按接收顺序交付、旧代次暂停无副作用。分别模拟接收保留失败、发送 `input.pause` 入队失败和发送 `input.suspended` 入队失败，验证独立关断。
  - M1U-30 暂缓 Session 消费通知，用同步点分别安排桌面回调先封闭和 Input 先取得许可。断言普通平台调用分别为零次和至多一次。覆盖初始未知、订阅失败、恢复通知和迟到的旧会话通知。
  - 在仅查看检查点通过后，接入 007 的触控与键盘，验证 AN-04–07。按 M1U-28 保持按钮按下并触发映射变化，验证旧坐标不会注入，清理确认后才开放槽位。

## 波次 4 · 联调、统计与验收

- [ ] T008 接入打点并运行全量 Debug CTest、Android 平台测试和 Android + Windows 真机验收（路径 `src/telemetry/`、`tests/integration/`、`test-results/m1/`。验证 ANH-01–03、M1H-01–06 和 001 §6，按编号归档 APK 与被控端版本、设备、链路和原始证据。）
  - M1H-04 保存测试环境、每类操作的可见反馈判定点与至少 20 个样本，分别计算 P95。核对每类 `≤ 200 ms` 及帧率、首帧和覆盖率。
  - M1H-06 在远程按住鼠标按钮时改变被控端分辨率。记录旧会话结束、按压释放、重新授权和新会话点击位置。

## 验收覆盖

| 验收编号 | 对应任务 |
| --- | --- |
| M1U-01–05、M1U-13、M1U-15–17、M1U-25 | T003、T004、T008 |
| M1U-18 | T003、T004、T007、T008 |
| M1U-06 | T003、T004、T005、T006、T007、T008 |
| M1U-07–09、M1U-11–12、M1U-20–21、M1U-26–27 | T005、T006、T008 |
| M1U-10、M1U-24 | T001、T002、T005、T006、T008 |
| M1U-14 | T007、T008 |
| M1U-19 | T003、T004、T008 |
| M1U-22 | T001、T002、T005、T006、T008 |
| M1U-23 | T005、T006、T007、T008 |
| M1U-28 | T001、T005、T006、T007、T008 |
| M1U-29 | T003、T005、T006、T008 |
| M1U-30 | T001、T002、T005、T006、T008 |
| M1H-01–03、M1H-05 | T008 |
| M1H-04 | T008 |
| ANH-01 | T007、T008 |
| ANH-02–03、M1H-06 | T006、T008 |
