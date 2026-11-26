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

## 技术决策与风险

- 采集和注入的后端替换只在装配时建立。底层通用失败及桌面状态通过各自的输入报告，采集和注入不在热路径同步查询 Session。Windows 适配器以 005 提供的当前代次观察结果作为桌面分类证据。
- 先实现 PW-18、PW-21 的最小红绿循环，对应 M1 T002。后续采集及注入覆盖按任务清单完成。M1U-22 对关断及槽位的断言由 M1 波次 3 负责。
- 部分 `SendInput` 计数只能证明接受数量时，记账保留所有可能仍按下的项。逐项清理提供可观察的失败位置和重试进度。
- staging 拷贝、DPI 感知和系统对释放的接受结果需在交互式 Windows 上记录。保留固定缓冲，先用测量判断瓶颈。

## 验证与交付

用 `cmake --preset debug` 和 `cmake --build --preset debug -j` 接入测试。逐轮执行 `ctest --preset debug -R '^platform\.win\.' --output-on-failure`，再运行全量 Debug CTest。PW-13 的 Release 分支用对应 preset 验证。将红灯、绿灯、回归及 PWH-01–06 的环境和原始结果按编号记录在 `test-results/platform-win/`。
