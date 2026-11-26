// Platform contracts for input injection and desktop observation.
// Thread: any (interfaces declare their owner below).
#pragma once

#include <array>
#include <cstdint>
#include <string_view>
#include <type_traits>
#include <variant>

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
