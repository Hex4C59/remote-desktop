// Screen capture, input injection and desktop observation contracts.
// Thread: any (interfaces declare their owner below).
#pragma once

#include <array>
#include <chrono>
#include <cstdint>
#include <string_view>
#include <type_traits>
#include <variant>

#include "remotedesktop/frame_handoff.h"

namespace rd::platform {

  enum class PlatformError {
    kNotSupported, kPermissionDenied, kUnavailable, kSessionNotInteractive,
    kDisplayChanged, kTimeout, kNoNewFrame, kAlreadyInitialized, kAccessLost,
    kSecureDesktop, kInputCleanupPending, kInvalidArgument, kRenderSurfaceLost,
    kInternal,
  };

  template <typename T>
  using PlatformResult = std::variant<
      std::conditional_t<std::is_void_v<T>, std::monostate, T>, PlatformError>;

  struct CaptureConfig {
    std::uint32_t requested_width{};
    std::uint32_t requested_height{};
    std::uint32_t max_fps{30};
    std::uint32_t initial_display_map_version{1};
  };

  struct DisplayInfo {
    std::uint32_t width{};
    std::uint32_t height{};
    std::uint16_t dpi{96};
    float scale{1.0f};
    std::uint32_t display_map_version{1};
  };

  class ScreenCapture {
   public:
    // Thread: capture only. A null Frame probes without copying pixels.
    virtual PlatformResult<void> initialize(const CaptureConfig&) = 0;
    // timeout bounds the wait for a new frame. Windows may return kTimeout
    // earlier while a readback is in flight. The Frame is borrowed per call.
    virtual PlatformResult<FrameDesc> acquire_frame(
        Frame*, std::chrono::milliseconds) = 0;
    virtual PlatformResult<DisplayInfo> display_info() const = 0;
    virtual ~ScreenCapture() = default;
  };

  enum class InputKind : std::uint8_t {
    kPointerMove, kButtonDown, kButtonUp, kWheel, kKeyDown, kKeyUp, kText,
  };
  enum class Key : std::uint16_t {
    kNone = 0,
    kA, kB, kC, kD, kE, kF, kG, kH, kI, kJ, kK, kL, kM,
    kN, kO, kP, kQ, kR, kS, kT, kU, kV, kW, kX, kY, kZ,
    k0, k1, k2, k3, k4, k5, k6, k7, k8, k9,
    kF1, kF2, kF3, kF4, kF5, kF6, kF7, kF8, kF9, kF10, kF11, kF12,
    kLeftShift, kRightShift, kLeftCtrl, kRightCtrl,
    kLeftAlt, kRightAlt, kLeftWin, kRightWin,
    kEscape, kTab, kCapsLock, kSpace, kEnter, kBackspace, kDelete,
    kInsert, kHome, kEnd, kPageUp, kPageDown,
    kArrowUp, kArrowDown, kArrowLeft, kArrowRight,
    kMinus, kEqual, kLeftBracket, kRightBracket, kBackslash,
    kSemicolon, kQuote, kComma, kPeriod, kSlash, kBackquote,
    kCount,  // Mapping coverage boundary.
  };
  enum class MouseButton : std::uint8_t { kLeft, kRight, kMiddle };
  using SessionId = std::array<std::uint8_t, 16>;
  using InputEpoch = std::uint32_t;

  struct InputEvent {
    InputKind kind{InputKind::kPointerMove};
    Key key{Key::kNone};
    MouseButton button{MouseButton::kLeft};
    std::int32_t x{};
    std::int32_t y{};
    std::int32_t wheel_delta{};
    std::string_view text;
    std::uint32_t display_map_version{};
    std::uint64_t pointer_seq{};
    std::uint64_t source_timestamp_ns{};
    std::uint64_t inject_timestamp_ns{};
    SessionId session{};
    InputEpoch input_epoch{};
  };

  class InputInjector {
   public:
    // Thread: input only
    virtual PlatformResult<void> inject(InputEvent&) noexcept = 0;
    [[nodiscard]] virtual PlatformResult<void> release_all_pressed() noexcept = 0;
    virtual ~InputInjector() = default;
  };

  enum class DesktopState { kInteractive, kLocked, kSecureDesktop, kLoggedOut, kUnknown };
  using LocalSessionGeneration = std::uint64_t;

  struct DesktopObservation {
    LocalSessionGeneration generation;
    std::uint64_t sequence;
    DesktopState state;

    bool operator==(const DesktopObservation&) const = default;
  };
  using DesktopObserver = void (*)(void*, DesktopObservation) noexcept;

  class SessionState {
   public:
    // Thread: session only. The platform event source dispatches the observer.
    virtual PlatformResult<DesktopObservation> subscribe(
        LocalSessionGeneration, DesktopObserver, void*) noexcept = 0;
    virtual void unsubscribe(LocalSessionGeneration) noexcept = 0;
    virtual ~SessionState() = default;
  };

}  // namespace rd::platform
