# 平台抽象层

status: draft

状态：接口契约草案，无实现。平台相关代码只允许出现在 `src/platform/{win,linux,mac}/`；
业务与协议代码不得直接调用 `SendInput`、XTest、DXGI、Win32 窗口 API 或 Android API。

本文定义接口契约（类型、错误码、线程归属），实现留空。接口变更必须与本文同步，
且按 [AGENTS.md](../AGENTS.md) 第 8 节的要求先改本文再改代码。

## 1. 目录与文件归属

```text
src/platform/
  platform.h              # 平台无关的接口声明与类型（公共契约）
  win/
    screen_capture_win.cpp    # Thread: capture only
    input_inject_win.cpp      # Thread: input only
    session_state_win.cpp     # Thread: session only
    display_info_win.cpp      # Thread: any（纯查询，不阻塞）
    render_surface_win.cpp    # Thread: ui only（控制端）
  linux/ mac/                  # 同构实现，后续
tests/unit/platform/          # mock 实现，不依赖真实设备
```

规则：

- `platform.h` 只包含标准库与项目自有类型，不包含任何平台头文件。
- 每个实现文件头注释写明职责与线程归属。
- 平台实现不抛出跨边界异常；错误通过 `std::expected<T, PlatformError>` 返回（见第 6 节）。
- 平台实现不做日志格式化，只返回可上报的状态。

## 2. 错误类型

```cpp
enum class PlatformError {
  kNotSupported,        // 本平台不支持该能力（例如无硬件编解码）
  kPermissionDenied,    // 系统权限不足
  kUnavailable,         // 设备/资源当下不可用（可能重试成功）
  kSessionNotInteractive, // 不在已登录未锁屏的交互会话
  kDisplayChanged,      // 分辨率/DPI/拓扑变化，调用方须重建
  kTimeout,             // 平台调用超时
  kInternal,            // 不可分类，须附上下文
};
```

禁止用返回 `bool` + `errno` 或抛异常在平台边界表达失败。

## 3. 屏幕采集

```cpp
struct FrameDesc {
  uint32_t width, height;
  uint32_t stride;            // 字节
  PixelFormat format;         // 目前 kBGRA8；扩展须改规格
  uint64_t capture_timestamp_ns;   // 平台单调时钟
  FrameOwnership ownership;   // 谁负责释放、在哪个线程释放
};

class ScreenCapture {
 public:
  // Thread: capture only
  virtual std::expected<void, PlatformError> initialize(const CaptureConfig&);
  virtual std::expected<FrameDesc, PlatformError> acquire_next_frame(std::chrono::milliseconds timeout);
  virtual void release_frame(const FrameDesc&) noexcept;
  virtual std::expected<DisplayInfo, PlatformError> display_info() const;
  virtual ~ScreenCapture() = default;
};
```

契约：

- `acquire_next_frame` 是唯一阻塞点，且必须尊重 `timeout`；超时返回 `kTimeout`，不得无限等待。
- 返回的帧在调用 `release_frame` 前保持有效；实现必须说明内部是拷贝、映射还是共享纹理。
- 采集失败要区分“暂时无变化”（不是错误，返回无帧）与“设备丢失”（`kUnavailable`）。
- DPI 或分辨率变化时返回 `kDisplayChanged`，由调用方重建采集器，不在内部静默适配。
- 不得在采集路径做缩放、色彩转换或编码。

## 4. 输入注入

```cpp
struct InputEvent {
  InputKind kind;             // kPointerMove/kButton/kWheel/kKey/kText
  uint16_t button_or_key;     // 平台无关键值，见 4.1
  int32_t x, y;               // 绝对坐标（虚拟桌面坐标空间）
  int32_t wheel_delta;
  uint32_t display_map_version;
  uint64_t pointer_seq;
  uint64_t source_timestamp_ns;   // 控制端采集时刻
  uint64_t inject_timestamp_ns;   // 被控端注入时刻
  SessionId session;
  uint32_t input_epoch;
};

class InputInjector {
 public:
  // Thread: input only
  virtual std::expected<void, PlatformError> inject(const InputEvent&) noexcept;
  virtual void release_all_pressed() noexcept;   // 会话结束/断线时必调
  virtual ~InputInjector() = default;
};
```

契约：

- `inject` 不阻塞等待渲染或网络；失败只返回错误，由调用方决定是否结束会话。
- 注入前由调用方（Input 执行器）检查会话、`input_epoch` 与授权门禁；注入器不重复做业务判断。
- 每次成功按下都由注入器记账，`release_all_pressed` 必须无遗漏地释放。
- 坐标一律使用绝对虚拟桌面坐标 + `display_map_version`；由调用方换算，注入器不猜映射。
- 键值使用项目自定义的枚举，不暴露平台虚拟键码。

### 4.1 键值枚举

自定义 `Key` 枚举（`kA`…`kZ`、`k0`…`k9`、`kF1`…`kF12`、修饰键、导航键、`kNone`）。
平台实现负责枚举到平台键码或扫描码的映射表；映射表必须有单元测试覆盖完整性，
新增键值须同时改规格与两端映射表。

## 5. 会话与桌面状态

```cpp
enum class DesktopState { kInteractive, kLocked, kSecureDesktop, kLoggedOut, kUnknown };

class SessionState {
 public:
  // Thread: session only
  virtual DesktopState query() const noexcept;
  virtual std::expected<void, PlatformError> subscribe(std::function<void(DesktopState)>);  // 回调只投递事件
  virtual ~SessionState() = default;
};
```

契约：

- 非 `kInteractive` 一律结束会话，不得继续采集或注入。
- `subscribe` 的回调**不得**在回调里做业务判断或阻塞；只能向 Session 执行器投递事件。
- 不得把 SSH/Session 0 会话当成可采集桌面；`kUnknown` 按不可用处理。

## 6. 显示与 DP

```cpp
struct DisplayInfo {
  uint32_t width, height;
  uint16_t dpi;
  float scale;
  uint32_t display_map_version;   // 拓扑或缩放变化时递增
};
```

- 多显示器与旋转在 M2 定义，M1 只保证单显示器且 `display_map_version` 稳定。
- 变化时单调递增版本，控制端发现版本不一致即重新获取。
  版本回退属于 `kDisplayChanged`，不得继续注入旧坐标。

## 7. 渲染表面（控制端）

```cpp
class RenderSurface {
 public:
  // Thread: ui only
  virtual std::expected<void, PlatformError> present(const VideoFrame&) noexcept;
  virtual void resize(uint32_t width, uint32_t height) noexcept;
  virtual ~RenderSurface() = default;
};
```

- `VideoFrame` 的所有者由解码侧声明，`present` 不得保留引用到下一次调用之后。
- UI 线程不做网络读取；网络到渲染之间经过有界的“最新帧”移交。
- 渲染失败要区分“丢一帧可恢复”与“资源丢失需重建”。

## 8. 测试约定

- `tests/unit/platform/` 提供 mock 实现，可用脚本驱动：正常帧序列、`kDisplayChanged`、
  `kUnavailable`、超时、注入失败、会话切到锁屏。
- 单元测试禁止依赖真实屏幕、真实鼠标键盘或真实网络。
- 平台实现的冒烟测试若需要真实设备，放入 `tests/integration/` 并标注运行条件；
  它不替代延迟验收。

## 9. 变更流程

新增或修改本文件中的接口时：

1. 先改本文（接口、错误码、线程归属、不变量）；
2. 在 `specs/` 补充或更新验收场景；
3. 更新 mock 实现与单元测试；
4. 最后改平台实现。

未更新本文就改接口视为违规，须回退。
