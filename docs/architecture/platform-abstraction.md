# 平台抽象层

status: draft

平台相关代码位于 `src/platform/{win,linux,mac}/`。[007](../increments/007-android-controller/spec.md) 提议增加 `src/platform/android/`。
业务与协议代码不得直接调用 `SendInput`、XTest、DXGI、Win32 窗口 API 或 Android API。

本文说明各接口怎样调用、会返回什么结果或错误，以及应在哪个线程调用。接口变更必须与本文同步，
且按 [AGENTS.md](../../AGENTS.md) 第 8 节的要求先改本文再改代码。

## 1. 目录与文件归属

```text
include/remotedesktop/platform/platform.h  # 平台无关的公共接口声明与类型
src/platform/
  win/
    screen_capture_win.cpp    # Thread: capture only
    input_inject_win.cpp      # Thread: input only
    session_state_win.cpp     # Thread: session only
    display_info_win.cpp      # Thread: any（纯查询，不阻塞）
    render_surface_win.cpp    # Thread: ui only（控制端）
  linux/ mac/                  # 同构实现，后续
  android/                     # 007 待评审的 Java UI、JNI 和平台解码适配
tests/unit/platform/          # mock 实现，不依赖真实设备
```

规则：

- `platform.h` 只包含标准库与项目自有类型，不包含任何平台头文件。
- 每个实现文件头注释写明职责与线程归属。
- 平台实现不抛出跨边界异常，使用 §2 的 `PlatformResult<T>` 返回。
- 平台实现不做日志格式化，只返回可上报的状态。

## 2. 错误类型

```cpp
enum class PlatformError {
  kNotSupported,        // 本平台不支持该能力（例如无硬件编解码）
  kPermissionDenied,    // 系统权限不足
  kUnavailable,         // 设备/资源当下不可用（可能重试成功）
  kSessionNotInteractive, // 不在已登录未锁屏的交互会话
  kDisplayChanged,      // 分辨率/DPI/拓扑变化，调用方处理会话关闭或采集器重建
  kTimeout,             // 平台调用超时
  kNoNewFrame,          // 超时内画面无变化，不是错误
  kAlreadyInitialized,  // 重复 initialize
  kAccessLost,          // DXGI ACCESS_LOST：采集器不可用，须重建
  kSecureDesktop,       // 处于安全桌面或锁屏
  kInputCleanupPending, // 释放未全部得到平台确认，保留待清理按压
  kInvalidArgument,     // 调用参数或帧描述不合法
  kRenderSurfaceLost,   // 图形设备或表面失效，需重建
  kInternal,            // 不可分类，须附上下文
};

template <typename T>
using PlatformResult =
    std::variant<std::conditional_t<std::is_void_v<T>, std::monostate, T>, PlatformError>;
```

`PlatformResult<T>` 使用 C++20。成功返回值分支，`void` 成功返回 `std::monostate`。失败返回 `PlatformError` 分支。
禁止通过异常跨平台边界。

## 3. 屏幕采集

`FrameDesc` 的唯一定义在
[屏幕帧移交规格](../increments/002-screen-frame-handoff/spec.md) 第 2 节，源码为
`include/remotedesktop/frame_handoff.h`。`CaptureConfig` 和 `DisplayInfo` 的字段及默认值见
[Windows 平台适配规格 §2](../increments/003-platform-win/spec.md#2-接口约定)，与 `ScreenCapture` 一起由 `platform.h` 声明。

```cpp
// FrameDesc / PixelFormat 的定义见屏幕帧移交规格第 2 节。
// Frame / FramePool 引用计数约定帧的所有权。

class ScreenCapture {
 public:
  // Thread: capture only
  virtual PlatformResult<void> initialize(const CaptureConfig&) = 0;
  virtual PlatformResult<FrameDesc> acquire_frame(
      Frame* frame, std::chrono::milliseconds timeout) = 0;
  virtual PlatformResult<DisplayInfo> display_info() const = 0;
  virtual ~ScreenCapture() = default;
};
```

**怎样获取画面、会返回什么**

- Windows 空闲取帧使用 `timeout` 作为 DXGI 等待上限。等待无新帧、GPU 读回暂忙或读回已过期时返回 `kTimeout`，调用方继续轮询。
- 像素写入调用方提供的 `Frame`，采集器不持有帧引用，所有权仍归 `FramePool`。
- 调用者可以传入空帧指针探测新帧。成功时只获取描述，可用其中的 stride 计算帧池缓冲区大小。若已有一笔读回，探测等到查询就绪后消费该笔描述。
- Windows 适配器在装配时绑定当前会话代次的桌面状态读取入口。Capture 和 Input 读取 [005](../increments/005-windows-desktop-state/spec.md) 发布的快照，热路径无需查询 Session。没有绑定读取入口时，桌面状态为 `kUnknown`。
- Windows 采集跨调用只保留一笔读回和它的描述。源帧每次调用内释放，交付时使用原采集时间戳。桌面失效、映射变化或达到 33 ms 仍未开始 CPU 拷贝时作废该笔结果，命令完成后可重用纹理。 [Windows 读回约定](../increments/003-platform-win/spec.md#41-提交桌面帧拷贝与读取像素)
- `kNoNewFrame` 保留给能单独确认无变化的其他后端。DXGI 报告 `kAccessLost` 时须重建。Windows 读回出现终止错误时保留原错误，销毁并重建后再尝试。
- DPI、分辨率或显示拓扑变化时报告 `kDisplayChanged`，由调用方按当前使用场景处理。M1 会话关闭后重新获取映射。
- 不得在采集路径做缩放、色彩转换或编码。

## 4. 输入注入

[`InputEvent` 及相邻值类型](../increments/003-platform-win/spec.md#25-输入注入)的完整声明见 003，源码归属公共平台头。

```cpp
class InputInjector {
 public:
  // Thread: input only
  virtual PlatformResult<void> inject(InputEvent&) noexcept = 0;
  [[nodiscard]] virtual PlatformResult<void> release_all_pressed() noexcept = 0;
  virtual ~InputInjector() = default;
};
```

**怎样发送输入、怎样清理按下状态**

- `inject` 由 Input 执行器在取得一次注入许可后调用，并回填被控端单调时钟的 `inject_timestamp_ns`。
  注入器在返回前按实际效果记账，效果不明确时保留可能仍按下的项。具体规则见 [003 §2.7](../increments/003-platform-win/spec.md#27-平台效果与重试)。
  普通注入返回错误时，Input 执行器在领取下一条事件前终止封闭门禁并请求 Session 关断。
- `release_all_pressed` 由 Input 执行器调用，在普通输入门禁关闭后仍可使用，只处理本程序记账的按压。
  平台确认释放的项从记录移除。仍有未确认项时返回 `kInputCleanupPending`，下一次调用仅处理剩余项。
  成功表示记录确已清空。记录为空时重复调用直接成功。释放受桌面限制时保留记录，待交互桌面恢复后重试。
  两个调用均不得等待渲染、网络或下一帧。归还会话槽位由 [001 §2.3](../increments/001-android-controls-windows-over-lan/spec.md#23-输入门禁与清理) 定义。
- 坐标一律使用绝对虚拟桌面坐标 + `display_map_version`；由调用方换算，注入器不猜映射。
- 键值使用项目自定义的枚举，不暴露平台虚拟键码。

### 4.1 键值枚举

自定义 `Key` 枚举（`kA`…`kZ`、`k0`…`k9`、`kF1`…`kF12`、修饰键、导航键、`kNone`）。
平台实现负责枚举到平台键码或扫描码的映射表。单元测试用末尾的 `Key::kCount` 标记键值的覆盖范围。
新增键值须同时改规格与两端映射表。

## 5. 会话与桌面状态

```cpp
enum class DesktopState { kInteractive, kLocked, kSecureDesktop, kLoggedOut, kUnknown };
using LocalSessionGeneration = std::uint64_t;

struct DesktopObservation {
  LocalSessionGeneration generation;
  std::uint64_t sequence;
  DesktopState state;
};
using DesktopObserver = void (*)(void* context, DesktopObservation) noexcept;

class SessionState {
 public:
  // Thread: session only. The platform event source dispatches the observer.
  virtual PlatformResult<DesktopObservation> subscribe(
      LocalSessionGeneration generation, DesktopObserver observer, void* context) noexcept = 0;
  virtual void unsubscribe(LocalSessionGeneration generation) noexcept = 0;
  virtual ~SessionState() = default;
};
```

- `subscribe` 注册一个观察器并原子取得初始快照。序号从 1 开始，后续通知具有更高序号。重复订阅返回 `kAlreadyInitialized`，事件源不可用返回 `kUnavailable`，权限不足返回 `kPermissionDenied`，平台不支持返回 `kNotSupported`。失败不登记这次订阅。已能观察但当前状态未经证实，成功返回 `kUnknown`。
- 回调可早于 `subscribe` 返回，所有通知保留订阅代次。`unsubscribe` 对无匹配代次幂等，已开始派发的回调允许迟到。回调上下文由端点持有至平台事件源退出并确认派发全部返回。
- Session 消费同代次最新状态。初始不可交互、订阅失败或同代次非交互通知终止封闭门禁。通知先原子封闭，再写独立关断槽。恢复仅更新最新状态槽供清理重试。完整顺序、寿命和测试见 [005 桌面状态](../increments/005-windows-desktop-state/spec.md)。

## 6. 显示与 DP

```cpp
struct DisplayInfo {
  uint32_t width, height;
  uint16_t dpi;
  float scale;
  uint32_t display_map_version;   // 拓扑或缩放变化时递增
};
```

- M1 支持单显示器。每次会话固定一个 `display_map_version`，由被控端通过 `media.offer` 通知控制端。
- 映射变化时 Capture 通知 Session 结束会话。普通鼠标输入须匹配本次会话的固定版本。
  本地按压释放独立于旧映射，参见 [001 §2.3](../increments/001-android-controls-windows-over-lan/spec.md#23-输入门禁与清理)。
  重新授权后获取届时的映射。多显示器与旋转在 M2 定义。

## 7. 渲染表面（控制端）

```cpp
struct VideoFrameView {
  std::span<const std::byte> pixels;
  std::uint32_t width, height;
  std::size_t stride;
};

struct PresentedFrame {
  std::uint32_t x, y, width, height;  // Destination rectangle in client pixels.
};

class RenderSurface {
 public:
  // Thread: ui only
  virtual PlatformResult<PresentedFrame> present(const VideoFrameView&) noexcept = 0;
  virtual PlatformResult<void> resize(std::uint32_t width, std::uint32_t height) noexcept = 0;
  virtual ~RenderSurface() = default;
};
```

- `present` 借用解码侧的 BGRA8 SDR 像素至调用结束。显示矩形、错误和重建策略见 [006 渲染表面](../increments/006-windows-render-surface/spec.md)。
- Windows Decode 通过一槽覆盖移交帧。UI 核验当前会话及协商代次后呈现，首帧确认以本地呈现成功为依据。
- Android Surface 路径见 [007 的接口约定](../increments/007-android-controller/spec.md#2-接口约定)。UI 主线程管理 Surface 生命周期，Decode 持有用于系统解码的引用。仅当前表面代次的系统呈现回调可进入首帧槽，Decode 释放缓冲和引用后异步确认退出。

## 8. 测试约定

- `tests/unit/platform/` 提供 mock 实现，可用脚本驱动：正常帧序列、`kDisplayChanged`、
  `kUnavailable`、超时、注入失败、会话切到锁屏。
- 单元测试禁止依赖真实屏幕、真实鼠标键盘或真实网络。
- 平台实现的冒烟测试若需要真实设备，放入 `tests/integration/` 并标注运行条件；
  它不替代延迟验收。

## 9. 变更流程

新增或修改本文件中的接口时：

1. 先改本文（接口、错误码、线程归属、不变量）；
2. 在对应增量规格中补充或更新验收场景；
3. 更新 mock 实现与单元测试；
4. 最后改平台实现。

未更新本文就改接口视为违规，须回退。
