# Windows 屏幕采集与输入注入技术方案

## 规格与工程约束

依据 [003](spec.md)、[002 帧移交](../002-screen-frame-handoff/spec.md) 与 [005 桌面状态](../005-windows-desktop-state/spec.md)。沿用 C++20、Windows SDK 和现有 GoogleTest/GoogleMock。平台接口使用 [平台抽象 §2](../../architecture/platform-abstraction.md#2-错误类型) 的 `PlatformResult<T>`。代码按 Capture 和 Input 分属现有线程。

## 模块与数据流

| 模块 | 职责 |
| --- | --- |
| 公共平台头 `include/remotedesktop/platform/platform.h` | 声明平台值类型、错误、采集和注入接口。业务层只引用平台无关声明 |
| `src/platform/win/screen_capture_win.cpp` | 通过 Windows SDK 后端初始化 DXGI 及 staging 资源。Capture 路径在所有返回分支正确结束对已取得帧的访问，再把写入结果交还调用方 |
| `src/platform/win/input_inject_win.cpp` | 组装 Windows 输入，按平台报告更新固定容量按压表。释放路径逐项确认并保存重试进度 |
| `tests/unit/platform/win/` | 用脚本后端驱动真实采集或注入器。断言错误分支、资源释放顺序、派发内容和重试后的实际结果 |

## 采集与读回时序

[![单张 staging 纹理的提交、轮询和作废](readback-sequence.png)](readback-sequence.png)

[可编辑的 draw.io 时序图](readback-sequence.drawio)

Capture 在源帧释放前提交拷贝和 `D3D11_QUERY_EVENT`。`Flush` 交付命令，`GetData` 确认完成。读取 staging 纹理使用非等待映射。两次调用之间，采集器保存一笔读回的描述和映射版本。旧映射、离开交互桌面或已过 33 ms 的读回作废，完成查询后才可重用纹理。 [资源释放点](spec.md#41-提交桌面帧拷贝与读取像素)

## 技术决策与风险

- 采集和注入的后端替换只在装配时建立。底层通用失败及桌面状态通过各自的输入报告，采集和注入不在热路径同步查询 Session。Windows 适配器以 005 提供的当前代次观察结果作为桌面分类证据。
- 先实现 PW-18、PW-21 的最小红绿循环，对应 M1 T002。后续采集及注入覆盖按任务清单完成。M1U-22 对关断及槽位的断言由 M1 波次 3 负责。
- 部分 `SendInput` 计数只能证明接受数量时，记账保留所有可能仍按下的项。逐项清理提供可观察的失败位置和重试进度。
- 交互桌面用同一窗口负载记录所有零等待调用的耗时、实际交付帧率、帧龄和丢弃数。`Flush` 只提交命令，其实际耗时计入 6 ms 上限。用独立进程对照绘制、无像素探测和完整读回，并在具备权限时追踪堆和虚拟内存的分配来源。 [D3D11 命令提交](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-flush)

## 验证与交付

按 `debug` 和 `release` 预设分别配置、构建和运行全量 CTest。PW-22–26 先用脚本后端复现失败，再保存相同断言的通过结果。`windows-desktop` 预设用交付配置运行 PWH-01–06。PWH-01 比较相同预热后的首尾私有内存，PWH-06 验证所有零等待调用的最大值。将命令、被测版本、环境和原始结果保存至 `test-results/platform-win/`。 [真机运行说明](../../../tests/integration/platform/win/README.md)
