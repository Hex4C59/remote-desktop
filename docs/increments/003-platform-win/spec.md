# spec-platform-win：Windows 屏幕采集与输入注入

status: approved
approved-by: Hex4C59, 2026-11-24

本文定义 Windows 被控端平台层的两个能力：屏幕采集与输入注入。它们是
[001 · Android 手机在局域网远控 Windows 电脑](../001-android-controls-windows-over-lan/spec.md) 第 5 节实现顺序的第 2 步。
上游接口总纲见 [平台抽象](../../architecture/platform-abstraction.md)，
本文在其基础上补齐 Windows 特有的错误语义、所有权与验收场景。

**本规格不涉及**：会话状态检测（[005 桌面状态](../005-windows-desktop-state/spec.md)）、控制端[渲染表面](../006-windows-render-surface/spec.md)、
编码、传输、多显示器。

## 1. 范围

做：

- `ScreenCapture` 的 Windows 实现：Desktop Duplication API（DXGI）采集单个显示器。
- `InputInjector` 的 Windows 实现：`SendInput` 注入键鼠事件，按压状态记账与释放。
- 两者的 mock 实现，供单元测试使用。
- `FrameDesc` 的所有权语义与 `FramePool` 的衔接方式。

不做：

- 多显示器、旋转、HDR。M1 只保证单显示器 SDR。
- 窗口采集（只采整个桌面）。
- 硬件编解码、色彩空间转换、缩放。
- 锁屏 / 安全桌面 / UAC 下的采集与普通输入注入。检测到该状态时返回 `kSecureDesktop` 并结束会话。
  本地按压释放按 [001 §2.3](../001-android-controls-windows-over-lan/spec.md#23-输入门禁与清理) 执行。
- `SessionState` 的订阅与锁屏检测本身（见 [005](../005-windows-desktop-state/spec.md)）。

平台拒绝本地释放时保留待清理记录，在交互桌面恢复后重试。

## 2. 接口约定

### 2.1 消除 FrameDesc 重复定义（重要）

[平台抽象](../../architecture/platform-abstraction.md) 第 3 节与
[屏幕帧移交](../002-screen-frame-handoff/spec.md) 第 2 节各自声明了
`FrameDesc`，字段不同。二者必须在实现前合并为**唯一定义**，否则会出现两个同名类型。

合并结果即 [屏幕帧移交](../002-screen-frame-handoff/spec.md) 第 2 节的定义，
**该节是唯一定义处**，本节不重述字段。两份上游文档已回改为引用。

采纳该版本的依据：`display_map_version` 是采集与注入都需要的字段（注入前要校验坐标映射
版本是否一致）；原 docs 版本的 `FrameOwnership` 与引用计数重复表达所有权，故删除。

原 docs 版本中的 `FrameOwnership` 字段**删除**。理由：所有权由 `Frame`/`FramePool`
的引用计数表达（见 spec-screen-frame-handoff），用枚举再描述一遍会产生两套互相
矛盾的所有权表述。原字段想表达的“谁在哪个线程释放”改由规格文字约束：

- 采集器**不**持有帧引用的所有权；它把像素写入调用方提供的 `Frame`。
- `Frame` 由 `FramePool` 分配，引用归零时回到池，池的析构线程负责最终释放。

### 2.2 屏幕采集

```cpp
// 归属：include/remotedesktop/platform/win/screen_capture_win.h
// Thread: capture only（initialize 与 acquire 均只允许 Capture 线程）

struct CaptureConfig {
  std::uint32_t requested_width{};    // 0 表示使用显示器当前分辨率
  std::uint32_t requested_height{};
  std::uint32_t max_fps{30};          // 上限，实现可更低
  // 由 SessionContext 提供的起始版本号；采集器生命周期内在此基础上递增。
  std::uint32_t initial_display_map_version{1};
};

class ScreenCaptureWin final : public ScreenCapture {
 public:
  ScreenCaptureWin();
  ~ScreenCaptureWin() override;

  // 首次调用会初始化 DXGI 设备与输出复制对象。重复调用返回 kAlreadyInitialized。
  PlatformResult<void> initialize(const CaptureConfig& cfg) override;

  // 等待新帧。给定 frame 时把像素写入该帧并返回其描述。
  // frame 为空 = 只查询是否有新帧（探测模式）。成功时返回的 FrameDesc 描述当前
  // 显示器的宽/高/stride/格式，但像素未写入，调用方不得读取像素指针。
  // AcquireNextFrame 超时/无新帧时返回 kTimeout，调用方继续正常轮询。
  PlatformResult<FrameDesc> acquire_frame(
      Frame* frame, std::chrono::milliseconds timeout) override;

  // 显示器信息，纯查询，不阻塞。
  PlatformResult<DisplayInfo> display_info() const override;

  ScreenCaptureWin(const ScreenCaptureWin&) = delete;
  ScreenCaptureWin& operator=(const ScreenCaptureWin&) = delete;
};

// 错误码在 docs 的 PlatformError 基础上新增三项（见 2.3）
```

### 2.3 错误码

在 [平台抽象](../../architecture/platform-abstraction.md) 第 2 节的
`PlatformError` 上新增：

| 枚举值 | 触发条件 | 调用方处理 |
| --- | --- | --- |
| `kAlreadyInitialized` | 重复 `initialize` | 编程错误，Debug 下断言 |
| `kAccessLost` | DXGI 返回 `ACCESS_LOST`（分辨率/拓扑变化、切到安全桌面） | 销毁并重建采集器；一次采集周期内最多重建 3 次 |
| `kSecureDesktop` | 已确认处于安全桌面或锁屏 | 结束会话。DXGI `ACCESS_LOST` 单独返回 `kAccessLost`，桌面分类使用 [005](../005-windows-desktop-state/spec.md) |

保留 docs 中已有的 `kSessionNotInteractive`、`kDisplayChanged`、`kTimeout`、`kUnavailable`、
`kPermissionDenied`、`kNotSupported`、`kInternal`。

`kTimeout` 的语义在此明确：`AcquireNextFrame` 在给定 timeout 内没有新帧时返回 `kTimeout`，
它**不是失败**。调用方按正常轮询处理，不结束会话、不重建采集器。

`kAccessLost` 与 `kDisplayChanged` 的区别与后续处理：

- `kAccessLost`：DXGI 的运行时错误，采集器对象已不可用，必须销毁并重建。M1 远控在重建后须先确认
  采集映射仍与会话固定映射一致，再发布帧。发现映射变化时按 `kDisplayChanged` 关断。
- `kDisplayChanged`：检测到映射变化，但采集器对象仍可用。本次调用不产出帧，
  新版本号通过 `display_info()` 或下一次成功的 `acquire_frame` 可见。
  M1 远控发现映射变化即停止发布并交由 Session 结束会话，用户重新授权后使用当前映射。
  单独使用采集器时，调用方可继续取帧，连续 3 次报告 `kDisplayChanged` 仍不恢复时应重建。
  每次检测独立报告，采集器不维护 `kDisplayChanged` 计数器。

### 2.4 DisplayInfo 与 display_map_version

```cpp
struct DisplayInfo {
  std::uint32_t width{};
  std::uint32_t height{};
  std::uint16_t dpi{96};
  float scale{1.0f};
  std::uint32_t display_map_version{1};
};
```

`display_map_version` 由 **SessionContext 持有并单调递增**；采集器不持久化版本，
只维护生命周期内的内部当前值 `current_version_`。

赋值规则（M1 单显示器）：

- 采集器初始化时，`current_version_` 取自 `CaptureConfig::initial_display_map_version`
  （由 SessionContext 传入，默认为 1）。
- `width`、`height`、`dpi` 任一发生变化时，采集器先 `++current_version_`，
  再返回 `kDisplayChanged`；此后 `display_info()` 与 `FrameDesc.display_map_version`
  都报告新值。**返回 `kDisplayChanged` 的那次调用不产出帧**，
  新版本号通过 `display_info()` 或下一次成功的 `acquire_frame` 可见。
- 版本只增不减；回退视为实现错误，Debug 下断言。
- 采集器重建时由 SessionContext 传入当前版本作为起点，采集器**不重置为 1**，
  否则控制端无法区分“同一版本的新旧帧”。

`dpi` 与 `scale` 的关系：`dpi` 为显示器有效 DPI（`GetDpiForMonitor` 的默认值），
`scale = dpi / 96.0f`；两者必须自洽，单元测试断言该等式成立。

### 2.5 输入注入

```cpp
// 归属：include/remotedesktop/platform/win/input_inject_win.h
// Thread: input only

enum class InputKind : std::uint8_t {
  kPointerMove, kButtonDown, kButtonUp, kWheel, kKeyDown, kKeyUp, kText
};

enum class Key : std::uint16_t {
  kNone = 0,
  // 字母与数字
  kA, kB, kC, kD, kE, kF, kG, kH, kI, kJ, kK, kL, kM,
  kN, kO, kP, kQ, kR, kS, kT, kU, kV, kW, kX, kY, kZ,
  k0, k1, k2, k3, k4, k5, k6, k7, k8, k9,
  // 功能键
  kF1, kF2, kF3, kF4, kF5, kF6, kF7, kF8, kF9, kF10, kF11, kF12,
  // 修饰键
  kLeftShift, kRightShift, kLeftCtrl, kRightCtrl,
  kLeftAlt, kRightAlt, kLeftWin, kRightWin,
  // 导航与编辑
  kEscape, kTab, kCapsLock, kSpace, kEnter, kBackspace, kDelete,
  kInsert, kHome, kEnd, kPageUp, kPageDown,
  kArrowUp, kArrowDown, kArrowLeft, kArrowRight,
  // 符号（US 布局可打印 ASCII）
  kMinus, kEqual, kLeftBracket, kRightBracket, kBackslash,
  kSemicolon, kQuote, kComma, kPeriod, kSlash, kBackquote,
};

enum class MouseButton : std::uint8_t { kLeft, kRight, kMiddle };

struct InputEvent {
  InputKind kind{InputKind::kPointerMove};
  Key key{Key::kNone};              // 键盘事件用
  MouseButton button{MouseButton::kLeft};   // 按钮事件用
  std::int32_t x{};                 // 绝对坐标（虚拟桌面空间）
  std::int32_t y{};
  std::int32_t wheel_delta{};       // 正=向上/向前，单位 WHEEL_DELTA=120
  std::string_view text;            // kText 用，仅可打印 ASCII；其他 kind 必须为空
  std::uint32_t display_map_version{};
  std::uint64_t pointer_seq{};
  std::uint64_t source_timestamp_ns{};   // 控制端采集时刻
  std::uint64_t inject_timestamp_ns{};   // 被控端注入时刻；由 inject(InputEvent&) 就地回填
  SessionId session{};
  InputEpoch input_epoch{};
};

class InputInjectorWin final : public InputInjector {
 public:
  InputInjectorWin();
  ~InputInjectorWin() override;   // 仅允许在 Input 线程确认清理成功后析构

  // inject 会就地回填 ev.inject_timestamp_ns（取平台单调时钟）；
  // 调用方传入的 ev 在返回后可读取该字段，用于统计与延迟归因。
  // 返回错误前完成已确认及可能按下项的记账，供关断释放使用。
  // 远控 Input 执行器收到错误后在领取下一条事件前封闭门禁，见 001 §2.3。
  PlatformResult<void> inject(InputEvent& ev) noexcept override;

  // 成功表示所有按压均已确认释放。否则保留未确认项并返回 kInputCleanupPending。
  [[nodiscard]] PlatformResult<void> release_all_pressed() noexcept override;

  // 供测试与诊断：当前记账的按下项数量。
  std::size_t pressed_count() const noexcept;

  InputInjectorWin(const InputInjectorWin&) = delete;
  InputInjectorWin& operator=(const InputInjectorWin&) = delete;
};
```

`InputKind`、`Key`、`MouseButton`、`InputEvent` 是平台无关类型，由公共平台头声明。`InputEvent::text` 借用
调用方的字符存储，只在 `inject` 返回前有效。通过平台观察器确认锁屏或安全桌面时报 `kSecureDesktop`，
确认注销或无法证实交互时用 `kSessionNotInteractive`。没有桌面状态证据的系统调用失败按 `kInternal`。

### 2.6 键值映射

`Key` → Windows 虚拟键码（`VK_*`）的映射表必须有单元测试逐项覆盖：
对每个 `Key` 值断言映射结果非零且唯一（除 `kNone`）。新增 `Key` 未更新映射表时，
测试必须失败。

`kText` 使用 `SendInput` 的 `KEYEVENTF_UNICODE`，每个码元发送按下、释放各一次。先完整验证文本，
仅接受可打印 ASCII（0x20–0x7E），长度上限 256 字节。超出范围返回 `kNotSupported`，整项无平台调用。
文本转换及按压表使用装配阶段准备的固定容量，Unicode 按压以码元标识，与物理键分开。

### 2.7 平台效果与重试

| 可确认的效果 | 记账与返回 |
| --- | --- |
| 全部接受 | 按提交顺序应用所有效果。按下入账，确认释放移除账项。返回成功 |
| 明确全部未接受 | 保持原账项，普通注入返回对应错误 |
| 能确认按提交顺序接受的前缀 | 依次应用该前缀，保留未确认释放的账项，返回对应错误 |
| 无法确认逐项效果 | 保留原有且可能仍按下的账项，将此次可能按下的键、按钮或 Unicode 码元纳入账项。任何未经确认的释放均不移除账项。返回对应错误 |

`SendInput` 的接口仅返回计数。对多项批次，部分计数且缺乏逐项证据时按效果不确定处理。仅维护本程序可能造成的按压，
每个标识保留一项。已有项保留原位置，新项按提交顺序记账。普通调用失败前完成记账，不重放该事件。

`release_all_pressed` 按 §3 的顺序逐项提交，每项用平台确认为准。遇到首个拒绝或效果不确定即停止本轮并返回
`kInputCleanupPending`。已确认项立即移除。后续调用从剩余项继续；清除最后一项后返回成功。该路径只使用账项，
不要求原显示映射或开放门禁。全部确认前由 Input 保留注入器和记录，由 Session 保留会话槽位。

## 3. 不变量

1. **采集不分配。** `acquire_frame` 不申请内存；像素直接写入调用方提供的 `Frame`。
   DXGI 的 staging texture 在 `initialize` 时按最大分辨率分配一次。
2. **acquire 可中断。** `timeout` 到期必须返回 `kTimeout`，不得无限等待下一帧。
   `kTimeout` 表示“本次没等到新帧”，不是失败；调用方不得据此结束会话或重建采集器。
3. **采集只读。** 采集路径不做缩放、色彩转换、编码、日志字符串拼接。
4. **注入不阻塞。** `inject` 不等待渲染、网络或下一帧；只返回错误。
5. **按压可追溯。** 按平台实际接受的事件顺序更新记账，包括整体失败的调用中已接受的前缀。
   平台效果不明确时，为可能仍按下的项保留待清理记录。`release_all_pressed()` 成功时才承诺 `pressed_count() == 0`。
6. **释放顺序正确。** 先按逆序释放非修饰键（键盘与鼠标按钮统一按记录顺序逆序）。确认这些项全部释放后，
   再按逆序释放修饰键（Ctrl/Alt/Shift/Win）。只从记录中移除平台确认释放的项。锁屏、安全桌面或其他平台
   失败阻止释放时，返回 `kInputCleanupPending` 并保留未确认项。下次只处理剩余项。
7. **版本单调。** `display_map_version` 只增不减，采集器重建后继续递增。
8. **清理确认先于析构。** Input 所有者销毁注入器之前必须取得释放成功结果。Debug 下若析构时仍有未确认项则断言。
9. **恢复先确认旧代次清理。** Input 收到旧代次关断指令后清理，成功后才可切到新代次。注入器自身不检测 epoch。
   同一按键在按下状态再次收到 `kKeyDown` 时，Debug 断言，Release 返回 `kInternal`，计数不增加。
   业务层须先过滤合法的按键重复事件和异常的重复按下，不能把网络事件直接送入此断言路径。

10. **探测模式无像素。** `frame == nullptr` 时返回的 `FrameDesc` 不含有效像素，
    调用方必须检查 frame 是否为空再决定是否读像素。

11. **采集器不维护 `kDisplayChanged` 计数器。** 连续次数由调用方统计，
    采集器每次报告独立。采集器的跨调用状态仅限于 `current_version_`（见 §2.4）。

## 4. 线程与资源

| 项 | 规则 |
| --- | --- |
| `ScreenCaptureWin` 构造/initialize | 在 Capture 线程启动本会话采集任务前调用 |
| `acquire_frame` | 仅 Capture 线程 |
| `ScreenCaptureWin` 析构 | Capture 线程确认本会话采集任务停止后，由 Capture 线程析构 |
| DXGI 设备与 duplication 对象 | 由采集器独占，不跨线程共享 |
| staging texture | `initialize` 时分配，数量 1；不随帧数增长 |
| `InputInjectorWin` 全部方法 | 仅 Input 线程 |
| 按压状态表 | 注入器独占，无锁（单线程访问） |
| 帧缓冲 | 由端点 `FramePool` 拥有，采集器只写入。会话结束时确认所有本会话帧已释放，端点退出时按 002 销毁池 |
| `display_map_version` 所有权 | SessionContext 持有并递增；采集器只读传入值，维护内部 `current_version_` 并回填到 `DisplayInfo`/`FrameDesc` |
| 源文件实际路径 | `include/remotedesktop/platform/win/screen_capture_win.h`、`include/remotedesktop/platform/win/input_inject_win.h` |

热路径约束（与 [线程模型](../../architecture/threading.md) 第 4.3 节一致）：

- `acquire_frame` 与 `inject` 内禁止：动态分配、文件 I/O、日志格式化、异常。
- `acquire_frame` 的 `ReleaseFrame()` 必须在返回前调用，不得把 DXGI 资源留到下一帧，
  否则 duplication 接口会因未释放而停止产出新帧。

### 4.1 DXGI 采集流程与资源释放点

```text
initialize：
  D3D11CreateDevice
  → IDXGIOutput1::DuplicateOutput 得到 IDXGIOutputDuplication
  → 按 display_info 的宽高创建 1 张 staging texture

acquire_frame：
  AcquireNextFrame(timeout)
    ├ 超时        → kTimeout
    ├ ACCESS_LOST → kAccessLost
    └ 成功
        → IDXGIOutputDuplication::Map
        → 检查 desc 是否与上次一致（宽/高/格式）
            ├ 不一致 → release frame，返回 kDisplayChanged
            └ 一致   → Map 的 CPU 指针按行拷贝进 Frame（含 stride 校正）
        → Unmap
        → ReleaseFrame()        ← 必须在返回前，否则下一帧拿不到
        → 返回 FrameDesc
```

拷贝而非零拷贝：staging texture 是 CPU 可读的共享资源，DXGI 的 GPU 纹理不能直接被
后续编码读取。M1 明确接受这次拷贝的代价，零拷贝路径需另行测量后立项。

## 5. 验收场景

### 5.1 可自动化（mock，`tests/unit/platform/win/`）

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| PW-01 | 未 initialize 就 acquire | 返回 `kUnavailable`，不崩溃 |
| PW-02 | 重复 initialize | 第二次返回 `kAlreadyInitialized` |
| PW-03 | mock 无新帧，timeout=10ms | 返回 `kTimeout`，耗时在 10–100 ms 之间（CI 抖动容忍）；调用方按轮询处理，不重建 |
| PW-04 | mock 返回新帧 | `FrameDesc` 的宽高与 mock 一致，像素内容与 mock 提供的缓冲逐字节相等 |
| PW-05 | mock 返回 ACCESS_LOST | 返回 `kAccessLost`，且采集器标记为需重建 |
| PW-06 | 宽高变化（初始版本 5） | 返回 `kDisplayChanged`，**本次调用不返回 FrameDesc**；随后 `display_info().display_map_version == 6` |
| PW-07 | 连续两次 `display_info` 无变化 | `display_map_version` 相同 |
| PW-08 | 以 `initial_display_map_version=7` 重建后连续两次 `display_info()` | 两次均返回 7（起点不漂移），既不回到 1 也不自行递增 |
| PW-09 | 注入 pointer move | `SendInput` 被调用一次，`MOUSEEVENTF_ABSOLUTE` 已设置 |
| PW-10 | 注入 button down 再 release_all | `pressed_count()` 由 1 变 0，释放事件被发出 |
| PW-11 | 注入 key down 再 release_all | 同上，且释放顺序为逆序 |
| PW-12 | 未按下时调用 release_all | 幂等：不崩溃、不发出事件、`pressed_count()==0` |
| PW-13 | 同一按键重复 key down | 见不变量 9：Debug 断言失败；Release 下返回 `kInternal` 且计数不增加 |
| PW-14 | `kText` 含非 ASCII 码点 | 返回 `kNotSupported`，不发出任何事件 |
| PW-15 | `kText` 含可打印 ASCII | 每个字符发送 Unicode 按下与释放各一次。全部确认后无残留账项 |
| PW-16 | `Key` 枚举全覆盖映射测试 | 除 `kNone` 外每个值都映射到非零且唯一的 VK 码 |
| PW-17 | 析构时仍有按下项（Debug） | 断言失败 |
| PW-18 | 交互桌面上 mock 分别报告零接受、明确前缀及部分计数但逐项未知 | 返回 `kInternal`。验证已确认或可能按下的账项、未确认释放的保留，以及本地清理的实际调用序列。远控后续门禁行为由 M1U-22 验证 |
| PW-19 | 组合键 Ctrl+C 按下后 release_all | 先释放 C 再释放 Ctrl，最终 `pressed_count()==0` |
| PW-20 | stride 与实际宽度不匹配的帧 | 按 stride 逐行拷贝，`FrameDesc.stride` 如实反映 |
| PW-21 | 锁屏时释放被拒绝。另测首项释放成功后下一项释放拒绝或效果不确定 | 返回 `kInputCleanupPending`，仅移除已确认项，未确认非修饰项存在时不释放修饰键。重试按顺序只处理剩余项，最后一次成功后重复调用无平台调用 |

`SendInput` 在单元测试中通过 `InputInjectorWin` 的可注入后端替换（构造时传入函数指针），
不依赖真实鼠标键盘。mock 后端记录每次调用的事件序列供断言，其生命周期由测试 fixture
持有，`InputInjectorWin` 不拥有后端对象。

涉及 `inject` 的用例（PW-09~PW-19）使用非 const 的 `InputEvent` 局部对象，
以便断言注入器回填的 `inject_timestamp_ns` 非零。

### 5.2 真机（`tests/integration/`，需交互式桌面）

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| PWH-01 | 60 秒连续采集 | 无 `kAccessLost` 泄漏，帧率在设置上限内，内存不增长 |
| PWH-02 | 单独验证采集器时改变分辨率 | 收到 `kDisplayChanged`，丢弃本次结果，后续帧恢复。连续 3 次仍不恢复则重建后可继续采集。远控会话随映射变化关闭由 M1H-06 验证 |
| PWH-03 | 锁屏再解锁 | 锁屏期间返回 `kSecureDesktop`；解锁后重建可恢复 |
| PWH-04 | 注入点击与输入 | 目标窗口收到正确坐标与字符 |
| PWH-05 | 按住键时经本地入口结束会话 | 平台确认释放，本机状态无残留按下，随后可重新连接 |
| PWH-06 | 采集耗时测量 | 单帧 acquire ≤ 6 ms（与线程模型 4.2 的采集预算一致） |

PWH-06 只记录单帧采集的实测耗时。整套远控的延迟是否达标，按 [001 真机验收](../001-android-controls-windows-over-lan/spec.md#42-真机验收) 的要求判断。

## 6. 依赖与待决项

依赖：

| 依赖 | 用途 | 状态 | 引用状态 |
| --- | --- | --- | --- |
| DXGI / D3D11 | 桌面采集 | Windows SDK 自带，无需第三方 | 不适用 |
| `SendInput` | 输入注入 | user32，系统自带 | 不适用 |
| GoogleTest | 测试 | 已引入 | 不适用 |
| [屏幕帧移交](../002-screen-frame-handoff/spec.md) | `FrameDesc` 唯一定义、帧所有权 | `approved` | 已存在 |
| [001 · Android 手机在局域网远控 Windows 电脑](../001-android-controls-windows-over-lan/spec.md) | 交付范围与实现顺序 | Android 修订已批准 | 已存在 |
| `docs/architecture/platform-abstraction.md` | 平台接口总纲与错误码 | `draft` | 已存在（已回改为引用） |
| `docs/architecture/threading.md` | 线程与队列约束 | `approved` | 已存在 |
| `docs/architecture/overview.md` | 分层、依赖方向、关断顺序 | `draft` | 已存在 |
| [005 桌面状态](../005-windows-desktop-state/spec.md) | `kSecureDesktop` 与 `kSessionNotInteractive` 的判定 | `approved` | 已存在 |

不引入第三方采集库（如 DesktopDuplication 封装库）。理由：API 本身足够薄，
引入库会增加版本与 ABI 风险。

待决项，需用户决定后回改本文件：

1. **真机的桌面状态覆盖。** PWH-03 依赖 [005](../005-windows-desktop-state/spec.md) 的观察结果。真机须验证锁屏、解锁及状态未知的分类。
2. **staging texture 改为双缓冲。** 单张 texture 在拷贝期间无法接收新帧，
   60 FPS 下是否够用需实测（PWH-06）。若不够，需改本规格并重新验收。
3. **新会话的坐标换算。** `display_map_version` 对齐按 [控制协议 §4.3](../../protocol/README.md#43-媒体参数协商)，
   会话内映射变化按 [001 §2.3](../001-android-controls-windows-over-lan/spec.md#23-输入门禁与清理) 关断。
   控制端输入规格基于 [007 Android 呈现](../007-android-controller/spec.md#23-触控键盘与生命周期) 或 [006 Windows 呈现](../006-windows-render-surface/spec.md) 的视频矩形定义绝对坐标换算。
4. **输入注入的 DPI 感知。** `SendInput` 的绝对坐标依赖进程 DPI 感知级别；
   若进程未设 `DPI_AWARENESS_PER_MONITOR`，坐标会被系统缩放。需在平台初始化时
   明确设置并测试。
5. **上游文档回改进度跟踪。** 本规格依赖 `docs/architecture/platform-abstraction.md` 与
   [屏幕帧移交规格](../002-screen-frame-handoff/spec.md) 对 `FrameDesc` 采用引用而非重述。当前两者均已回改
   （见 §6 依赖表「引用状态」列）；若后续任一处再次出现重述定义，须先改回引用
   再更新本规格，否则同一类型会出现多份互相矛盾的字段表。

## 7. 并发自检

对照 [线程模型](../../architecture/threading.md) 第 5 节的 T-01~T-09：

| 编号 | 结论 |
| --- | --- |
| T-01 | 是。采集器属 Capture 线程，注入器属 Input 线程，均在第 1 节清单内 |
| T-02 | 是。本规格不新增跨线程边沿；帧经 ① 帧槽移交，注入从 Input 执行器调用 |
| T-03 | 不适用。本规格不新增队列；帧槽上限由 frame-handoff 规格定义 |
| T-04 | 由 4.1 与第 3 节约束：acquire 与 inject 内禁止分配、I/O、日志格式化 |
| T-05 | 是。`acquire_frame` 只等 DXGI（有 timeout），不等其他线程；`inject` 完全不等 |
| T-06 | 是。关闭输入和停止会话任务后由所属线程释放会话资源，按压未确认释放时保留清理状态 |
| T-07 | 是。新增文件必须有 `// Thread: capture only` 或 `// Thread: input only` |
| T-08 | 否。本规格不新增线程 |
| T-09 | 不适用。本规格不含延迟优化；PWH-06 只采集基线数据 |
