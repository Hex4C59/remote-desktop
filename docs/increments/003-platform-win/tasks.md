# Windows 屏幕采集与输入注入任务清单

## 依据

[003 规格](spec.md) · [技术方案](plan.md) · [M1 T002](../001-android-controls-windows-over-lan/tasks.md)。规格获批后执行，各行为先观察预期断言失败，再实现。

## 波次 1 · 注入记账与释放

- [x] T001 声明公共接口、Windows 注入器及可注入后端，接入可编译测试占位（路径 `src/platform/`、`include/remotedesktop/platform/win/`、`tests/unit/platform/win/`、CTest 接线。验证 `arch.layers` 和可发现性。）
- [x] T002 写并运行 PW-18、PW-21 的 mock 失败测试。分别驱动零接受、明确接受前缀、无法归因的部分计数，以及释放中途失败、桌面不可用和重试（路径 `tests/unit/platform/win/input_inject_win_test.cpp`。验证账项、错误、实际释放顺序和重试调用，保存行为断言红灯。）
- [x] T003 实现 PW-18、PW-21 的记账及逐项释放，重跑红灯用例（路径 `src/platform/win/input_inject_win.cpp`。验证同一断言转绿。）

本波次的 mock 红绿与全量回归证据见 `test-results/m1-t002.md`。原生 `SendInput` 后端由 T005 接入。

## 波次 2 · 其余平台行为

- [x] T004 按红绿循环补齐 DXGI 采集、探测、映射与释放分支（路径 `src/platform/win/screen_capture_win.cpp`、`tests/unit/platform/win/screen_capture_win_test.cpp`。验证 PW-01–08、PW-20。）
- [x] T005 接入原生 `SendInput` 后端，按红绿循环补齐键鼠、文本、映射与生命周期分支（路径 `src/platform/win/input_inject_win.cpp`、`tests/unit/platform/win/input_inject_win_test.cpp`。验证 PW-09–17、PW-19。PW-13 两个配置均须验证。）

波次 2 的红灯、绿灯和全量回归记录见 `test-results/platform-win/wave-2.md`。

## 最终波次 · 验收与证据

- [ ] T006 验证单张纹理的非等待读回和 Windows 真机结果。保留 PW-22–26 红绿；按 2026-11-27 获批修订增加 PW-27 采样判定与 PW-28 报告解析红绿。运行目标和全量 Debug、Release CTest；同一交付构建完成三个独立进程的 PWH-01/06、600 秒 PWH-07 和 PWH-02–05，独立诊断构建完成十轮 PWH-08。全部通过后才收口。
  - 原零增长条款下，Git `95bf60b` 增加 408 KiB，线程选项候选独立复跑增加 28 KiB。旧失败与成功均保留在 `test-results/platform-win/t006-closeout.md`。修订批准仅改变验收条款，不代表新用例已经通过。帧率、像素、33 ms 帧龄和 6 ms 调用要求继续适用。 [真机运行说明](../../../tests/integration/platform/win/README.md)
  - 2026-11-27 本轮新规则实测：旧策略用相同采样器复现 60 秒净增 384 KiB 的断言 RED；候选三个固定进程均满足内存及 6 ms 预算，但第二次像素失败；600 秒净增 8 KiB、采样峰值增量 108 KiB，仍有像素失败。PWH-02 和实际锁屏/解锁的 PWH-03 通过，PWH-04/05 在初始光标位置失败。SDK 十轮报告在开启线程追踪、包含内部引用后仍缺少在用的 duplication，PWH-08 为诊断能力阻塞。Debug 95/95、Release 96/96 通过。全部原始样本、失败、构建散列和后续条件见 `test-results/platform-win/t006-budget-revision.md`；T006 保持开放。
  - 2026-11-28 同一最终构建 `9d9760a7` 复验：PWH-01/06 三进程 3/3 通过，PWH-04/05 通过；另一次三进程批次因人工拖动测试窗口成为无效运行，不计入。一次 60 秒样本有 1 帧交付帧龄 33.44 ms，当前用例只记录而未断言，收口前需按规格确认判定口径。PWH-07、PWH-08 及最终构建上的 PWH-02/03 仍待执行，T006 保持开放。

## 验收覆盖

| 验收编号 | 对应任务 |
| --- | --- |
| PW-18、PW-21 | T002、T003、T006 |
| PW-01–08、PW-20 | T004、T006 |
| PW-09–17、PW-19 | T005、T006 |
| PW-22–28 | T006 |
| PWH-01–08 | T006 |
