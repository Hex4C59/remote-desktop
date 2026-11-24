# spec-platform-win：Windows 屏幕采集与输入注入

status: draft
approved-by: （待用户评审批准）

本文定义 Windows 被控端平台层的两个能力：屏幕采集与输入注入。它们是
[局域网纵向切片](../001-lan-vertical-slice/spec.md) 第 5 节实现顺序的第 2 步。
上游接口总纲见 [平台抽象](../../architecture/platform-abstraction.md)，
本文在其基础上补齐 Windows 特有的错误语义、所有权与验收场景。

**本规格不涉及**：会话状态检测（`SessionState`，另立规格）、渲染表面（控制端，另立规格）、
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
- 锁屏 / 安全桌面 / UAC 下的采集与注入。检测到该状态时必须返回 `kSecureDesktop`
  并结束会话，但不得继续采集或注入——这两件事分属「必做」与「不做」，见下方说明。
- `SessionState` 的订阅与锁屏检测本身（另立规格，见 §6 依赖表）。

「不做锁屏下采集与注入」不等于「不检测锁屏」。M1 必须识别该状态并返回
`kSecureDesktop`，否则会话无法及时结束；但识别之后只做结束处理，不继续采集、
不注入任何输入。

## 2. 接口契约

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

class ScreenCaptureWin {
 public:
  ScreenCaptureWin();
  ~ScreenCaptureWin();

  // 首次调用会初始化 DXGI 设备与输出复制对象。重复调用返回 kAlreadyInitialized。
  std::expected<void, PlatformError> initialize(const CaptureConfig& cfg);

  // 等待新帧。给定 frame 时把像素写入该帧并返回其描述。
  // frame 为空 = 只查询是否有新帧（探测模式）。成功时返回的 FrameDesc 描述当前
  // 显示器的宽/高/stride/格式，但像素未写入，调用方不得读取像素指针。
  // AcquireNextFrame 超时/无新帧时返回 kTimeout。这不是错误语义上的失败，
  // 调用方按正常轮询处理：继续等待或降低采集频率。
  std::expected<FrameDesc, PlatformError> acquire_frame(
      Frame* frame,
      std::chrono::milliseconds timeout);

  // 显示器信息，纯查询，不阻塞。
  std::expected<DisplayInfo, PlatformError> display_info() const;

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
| `kSecureDesktop` | 当前处于安全桌面或锁屏 | 结束会话，不重试。M1 阶段若 `SessionState` 未就绪，只能从 `ACCESS_LOST` 间接推断，**接受与 `kAccessLost` 的误报**；`SessionState` 规格就绪后替换为精确判定 |

保留 docs 中已有的 `kSessionNotInteractive`、`kDisplayChanged`、`kTimeout`、`kUnavailable`、
`kPermissionDenied`、`kNotSupported`、`kInternal`。

`kTimeout` 的语义在此明确：`AcquireNextFrame` 在给定 timeout 内没有新帧时返回 `kTimeout`，
它**不是失败**。调用方按正常轮询处理，不结束会话、不重建采集器。

`kAccessLost` 与 `kDisplayChanged` 的区别与后续处理：

- `kAccessLost`：DXGI 的运行时错误，采集器对象已不可用，必须销毁并重建。
- `kDisplayChanged`：检测到配置变化，但**采集器仍可用**，下一帧可继续 `acquire_frame`。
  返回 `kDisplayChanged` 时本次调用不产出帧，调用方丢弃本次结果；
  新版本号通过 `display_info()` 或下一次成功的 `acquire_frame` 可见。
  若连续 3 次 `kDisplayChanged` 仍不恢复，调用方应主动重建采集器。
  采集器不维护 `kDisplayChanged` 计数器，每次都是独立报告。

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

class InputInjectorWin {
 public:
  InputInjectorWin();
  ~InputInjectorWin();   // 析构时自动调用 release_all_pressed()

  // inject 会就地回填 ev.inject_timestamp_ns（取平台单调时钟）；
  // 调用方传入的 ev 在返回后可读取该字段，用于统计与延迟归因。
  std::expected<void, PlatformError> inject(InputEvent& ev) noexcept;

  // 释放本注入器记录的所有按下状态。幂等：无按下时不做事、不报错。
  void release_all_pressed() noexcept;

  // 供测试与诊断：当前记账的按下项数量。
  std::size_t pressed_count() const noexcept;

  InputInjectorWin(const InputInjectorWin&) = delete;
  InputInjectorWin& operator=(const InputInjectorWin&) = delete;
};
```

### 2.6 键值映射

`Key` → Windows 虚拟键码（`VK_*`）的映射表必须有单元测试逐项覆盖：
对每个 `Key` 值断言映射结果非零且唯一（除 `kNone`）。新增 `Key` 未更新映射表时，
测试必须失败。

`kText` 使用 `SendInput` 的 `KEYEVENTF_UNICODE`，每个 UTF-16 码元一次事件。
M1 只允许可打印 ASCII（0x20–0x7E）；遇到其他码点返回 `kNotSupported`，
不做静默丢弃或替换。

## 3. 不变量

1. **采集不分配。** `acquire_frame` 不申请内存；像素直接写入调用方提供的 `Frame`。
   DXGI 的 staging texture 在 `initialize` 时按最大分辨率分配一次。
2. **acquire 可中断。** `timeout` 到期必须返回 `kTimeout`，不得无限等待下一帧。
   `kTimeout` 表示“本次没等到新帧”，不是失败；调用方不得据此结束会话或重建采集器。
3. **采集只读。** 采集路径不做缩放、色彩转换、编码、日志字符串拼接。
4. **注入不阻塞。** `inject` 不等待渲染、网络或下一帧；只返回错误。
5. **按压可追溯。** 每次成功的 `kButtonDown`/`kKeyDown` 都被记账；
   `release_all_pressed` 后 `pressed_count() == 0`。
6. **释放顺序正确。** 先按逆序释放所有按下记录中的非修饰键（键盘与鼠标按钮统一按
   记录顺序逆序）；确认非修饰键全部释放后，再按逆序释放修饰键
   （Ctrl/Alt/Shift/Win）。避免组合键在释放途中被中间态误判。
7. **版本单调。** `display_map_version` 只增不减，采集器重建后继续递增。
8. **析构即释放。** `InputInjectorWin` 析构时必须已调用 `release_all_pressed()`，
   否则 Debug 断言失败（避免进程退出时按键卡在系统里）。
9. **不跨会话记账。** `input_epoch` 变化时调用方必须先 `release_all_pressed()`；
   注入器自身不检测 epoch。同一按键在按下状态再次收到 `kKeyDown` 时：
   Debug 断言失败；Release 下不重复增加 `pressed_count`，返回 `kInternal`。

10. **探测模式无像素。** `frame == nullptr` 时返回的 `FrameDesc` 不含有效像素，
    调用方必须检查 frame 是否为空再决定是否读像素。

11. **采集器不维护 `kDisplayChanged` 计数器。** 连续次数由调用方统计，
    采集器每次报告独立。采集器的跨调用状态仅限于 `current_version_`（见 §2.4）。

## 4. 线程与资源

| 项 | 规则 |
| --- | --- |
| `ScreenCaptureWin` 构造/initialize | Capture 线程创建之前；仅 Capture 线程可调用 |
| `acquire_frame` | 仅 Capture 线程 |
| `ScreenCaptureWin` 析构 | Capture 线程退出之后；见架构总览 5.3 第 3 步 |
| DXGI 设备与 duplication 对象 | 由采集器独占，不跨线程共享 |
| staging texture | `initialize` 时分配，数量 1；不随帧数增长 |
| `InputInjectorWin` 全部方法 | 仅 Input 线程 |
| 按压状态表 | 注入器独占，无锁（单线程访问） |
| 帧缓冲 | 由 `FramePool` 拥有，采集器只写入不持有；`FramePool` 由会话拥有，析构在 Capture 与 Encode 线程均退出之后 |
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
| PW-15 | `kText` 含可打印 ASCII | 每个字符一个 `KEYEVENTF_UNICODE` 事件 |
| PW-16 | `Key` 枚举全覆盖映射测试 | 除 `kNone` 外每个值都映射到非零且唯一的 VK 码 |
| PW-17 | 析构时仍有按下项（Debug） | 断言失败 |
| PW-18 | `inject` 期间 mock 返回 FALSE 或事件数不符 | 返回 `kInternal`，不改动记账状态；诊断信息记录期望与实际的事件数 |
| PW-19 | 组合键 Ctrl+C 按下后 release_all | 先释放 C 再释放 Ctrl，最终 `pressed_count()==0` |
| PW-20 | stride 与实际宽度不匹配的帧 | 按 stride 逐行拷贝，`FrameDesc.stride` 如实反映 |

`SendInput` 在单元测试中通过 `InputInjectorWin` 的可注入后端替换（构造时传入函数指针），
不依赖真实鼠标键盘。mock 后端记录每次调用的事件序列供断言，其生命周期由测试 fixture
持有，`InputInjectorWin` 不拥有后端对象。

涉及 `inject` 的用例（PW-09~PW-19）使用非 const 的 `InputEvent` 局部对象，
以便断言注入器回填的 `inject_timestamp_ns` 非零。

### 5.2 真机（`tests/integration/`，需交互式桌面）

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| PWH-01 | 60 秒连续采集 | 无 `kAccessLost` 泄漏，帧率在设置上限内，内存不增长 |
| PWH-02 | 改变分辨率 | 收到 `kDisplayChanged`，丢弃本次结果，后续帧恢复；若连续 3 次仍不恢复则重建后可继续采集 |
| PWH-03 | 锁屏再解锁 | 锁屏期间返回 `kSecureDesktop`；解锁后重建可恢复 |
| PWH-04 | 注入点击与输入 | 目标窗口收到正确坐标与字符 |
| PWH-05 | 按住键时结束进程 | 按键不残留（由系统或析构释放兜底） |
| PWH-06 | 采集耗时测量 | 单帧 acquire ≤ 6 ms（与线程模型 4.2 的采集预算一致） |

PWH-06 只记录实测值，不据此宣称延迟达标；延迟验收在里程碑级规格。

## 6. 依赖与待决项

依赖：

| 依赖 | 用途 | 状态 | 引用状态 |
| --- | --- | --- | --- |
| DXGI / D3D11 | 桌面采集 | Windows SDK 自带，无需第三方 | 不适用 |
| `SendInput` | 输入注入 | user32，系统自带 | 不适用 |
| GoogleTest | 测试 | 已引入 | 不适用 |
| [屏幕帧移交](../002-screen-frame-handoff/spec.md) | `FrameDesc` 唯一定义、帧所有权 | `approved` | 已存在 |
| [局域网纵向切片](../001-lan-vertical-slice/spec.md) | 里程碑与实现顺序 | `draft` | 已存在 |
| `docs/architecture/platform-abstraction.md` | 平台接口总纲与错误码 | `draft` | 已存在（已回改为引用） |
| `docs/architecture/threading.md` | 线程与队列约束 | `approved` | 已存在 |
| `docs/architecture/overview.md` | 分层、依赖方向、关断顺序 | `draft` | 已存在 |
| `SessionState` 规格 | `kSecureDesktop` 的判定 | **阻塞：未创建** | 缺失 |

不引入第三方采集库（如 DesktopDuplication 封装库）。理由：API 本身足够薄，
引入库会增加版本与 ABI 风险。

待决项，需用户决定后回改本文件：

1. **会话状态检测的归属。** `kSecureDesktop` 与 `kSessionNotInteractive` 的判定依赖
   `SessionState`，后者另立规格。在那之前，Windows 采集器只能从 DXGI 的 ACCESS_LOST
   间接推断，无法区分“锁屏”与“改分辨率”。这可能让 PWH-03 无法准确实现。
2. **staging texture 改为双缓冲。** 单张 texture 在拷贝期间无法接收新帧，
   60 FPS 下是否够用需实测（PWH-06）。若不够，需改本规格并重新验收。
3. **`display_map_version` 跨进程一致性。** 控制端的版本与采集器的版本如何对齐，
   属协议/传输议题，未在本规格定义。
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
| T-06 | 是。关断顺序遵循架构总览 5.3，采集器析构在 Capture 线程退出之后 |
| T-07 | 是。新增文件必须有 `// Thread: capture only` 或 `// Thread: input only` |
| T-08 | 否。本规格不新增线程 |
| T-09 | 不适用。本规格不含延迟优化；PWH-06 只采集基线数据 |
