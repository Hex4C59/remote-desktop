// Windows press bookkeeping against a platform input backend.
// Thread: input only
#include "remotedesktop/platform/win/input_inject_win.h"

#include <algorithm>
#include <chrono>
#include <optional>

#include "input_system_win.h"
#include "remotedesktop/assert.h"

namespace rd::platform::win {
  namespace {
    bool is_modifier(const PressIdentity& identity) noexcept {
      const auto* key = std::get_if<Key>(&identity);
      return key != nullptr && *key >= Key::kLeftShift && *key <= Key::kRightWin;
    }

    PlatformError injection_error(DesktopState state) noexcept {
      switch (state) {
        case DesktopState::kLocked:
        case DesktopState::kSecureDesktop:
          return PlatformError::kSecureDesktop;
        case DesktopState::kLoggedOut:
        case DesktopState::kUnknown:
          return PlatformError::kSessionNotInteractive;
        case DesktopState::kInteractive:
          return PlatformError::kInternal;
      }
      return PlatformError::kInternal;
    }

    // Windows virtual-key values in Key order, including the non-key kNone.
    constexpr auto kVirtualKeys =
        std::to_array<std::uint16_t>(
            {0,    'A',  'B',  'C',  'D',  'E',  'F',  'G',  'H',  'I',  'J',
             'K',  'L',  'M',  'N',  'O',  'P',  'Q',  'R',  'S',  'T',  'U',
             'V',  'W',  'X',  'Y',  'Z',  '0',  '1',  '2',  '3',  '4',  '5',
             '6',  '7',  '8',  '9',  0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76,
             0x77, 0x78, 0x79, 0x7a, 0x7b, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5,
             0x5b, 0x5c,  // Left/right modifiers.
             0x1b, 0x09, 0x14, 0x20, 0x0d, 0x08, 0x2e, 0x2d, 0x24, 0x23, 0x21,
             0x22, 0x26, 0x28, 0x25, 0x27,  // Arrows.
             0xbd, 0xbb, 0xdb, 0xdd, 0xdc, 0xba, 0xde, 0xbc, 0xbe, 0xbf, 0xc0});
    static_assert(kVirtualKeys.size() == static_cast<std::size_t>(Key::kCount));

    bool is_extended_key(Key key) noexcept {
      return key == Key::kRightCtrl || key == Key::kRightAlt ||
             key == Key::kLeftWin || key == Key::kRightWin ||
             (key >= Key::kDelete && key <= Key::kArrowRight);
    }

    InputPacket press_packet(const PressChange& change) noexcept {
      const bool up = change.action == PressAction::kUp;
      const auto key_flags = up ? kKeyUp : 0;
      if (const auto* key = std::get_if<Key>(&change.identity)) {
        return {.kind = InputPacketKind::kKeyboard,
                .flags = key_flags | (is_extended_key(*key) ? kKeyExtended : 0),
                .virtual_key = kVirtualKeys[static_cast<std::size_t>(*key)]};
      }
      if (const auto* button = std::get_if<MouseButton>(&change.identity)) {
        constexpr std::array down{kMouseLeftDown, kMouseRightDown,
                                  kMouseMiddleDown};
        constexpr std::array release{kMouseLeftUp, kMouseRightUp,
                                     kMouseMiddleUp};
        return {.flags =
                    (up ? release : down)[static_cast<std::size_t>(*button)]};
      }
      return {.kind = InputPacketKind::kKeyboard,
              .flags = key_flags | kKeyUnicode,
              .scan_code = std::get<char16_t>(change.identity)};
    }

    std::optional<std::int32_t> absolute_coordinate(
        std::int32_t position, std::int32_t origin,
        std::int32_t extent) noexcept {
      const auto offset = static_cast<std::int64_t>(position) - origin;
      if (offset < 0 || offset >= extent) {
        return std::nullopt;
      }
      if (offset == 0) {
        return 0;
      }
      constexpr std::int64_t kRange = 65'536;
      if (offset == extent - 1) {
        return kRange - 1;
      }
      // Round up to the first normalized coordinate that resolves to this
      // pixel.
      const auto normalized = (offset * kRange + extent - 1) / extent;
      return static_cast<std::int32_t>(std::min(normalized, kRange - 1));
    }

    class SystemInputBackend final : public InputPressBackend {
     public:
      SystemInputBackend(InputSystemWin system,
                         DesktopStateReader desktop) noexcept
          : system_(system), desktop_(desktop) {}

      DesktopState desktop_state() const noexcept override {
        return desktop_.state();
      }

      InputBatchResult submit(
          std::span<const PressChange> changes) noexcept override {
        if (system_.submit == nullptr || changes.size() > packets_.size()) {
          return {0, true};
        }
        const auto packets = std::span{packets_}.first(changes.size());
        std::ranges::transform(changes, packets.begin(), press_packet);
        const auto accepted = system_.submit(system_.context, packets);
        return {accepted, accepted == 0 || accepted == packets.size()};
      }

      PlatformResult<void> submit_motion(
          const InputEvent& event) noexcept override {
        InputPacket packet{.flags = kMouseWheel,
                           .wheel_delta = event.wheel_delta};
        if (event.kind == InputKind::kPointerMove) {
          if (system_.bounds == nullptr) {
            return PlatformError::kUnavailable;
          }
          const auto bounds = system_.bounds(system_.context);
          if (bounds.width <= 0 || bounds.height <= 0) {
            return PlatformError::kUnavailable;
          }
          const auto x = absolute_coordinate(event.x, bounds.x, bounds.width);
          const auto y = absolute_coordinate(event.y, bounds.y, bounds.height);
          if (!x || !y) {
            return PlatformError::kInvalidArgument;
          }
          packet = {.flags = kMouseMove | kMouseVirtualDesk | kMouseAbsolute,
                    .x = *x,
                    .y = *y};
        }
        if (system_.submit == nullptr ||
            system_.submit(system_.context, std::span{&packet, 1}) != 1) {
          return injection_error(desktop_state());
        }
        return std::monostate{};
      }

     private:
      InputSystemWin system_;
      DesktopStateReader desktop_;
      std::array<InputPacket, kMaxInputPackets> packets_{};
    };
  }  // namespace

  InputInjectorWin::InputInjectorWin()
      : InputInjectorWin(DesktopStateReader{}) {}
  InputInjectorWin::InputInjectorWin(DesktopStateReader desktop)
#ifdef _WIN32
      : InputInjectorWin(native_input_system(), desktop) {
  }
#else
  {
    static_cast<void>(desktop);
  }
#endif
  InputInjectorWin::InputInjectorWin(InputSystemWin system,
                                     DesktopStateReader desktop)
      : owned_backend_(std::make_unique<SystemInputBackend>(system, desktop)),
        backend_(owned_backend_.get()) {}
  InputInjectorWin::InputInjectorWin(InputPressBackend& backend) noexcept : backend_(&backend) {}

  InputInjectorWin::~InputInjectorWin() {
    RD_ASSERT(pressed_count_ == 0);
  }

  PlatformResult<void> InputInjectorWin::inject(InputEvent& event) noexcept {
    if (backend_ == nullptr) {
      return PlatformError::kNotSupported;
    }
    const auto state = backend_->desktop_state();
    if (state != DesktopState::kInteractive) {
      return injection_error(state);
    }
    const auto timestamp = std::chrono::steady_clock::now().time_since_epoch();
    event.inject_timestamp_ns = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(timestamp).count());

    if (event.kind != InputKind::kText && !event.text.empty()) {
      return PlatformError::kNotSupported;
    }
    switch (event.kind) {
      case InputKind::kKeyDown:
      case InputKind::kKeyUp: {
        if (event.key <= Key::kNone || event.key >= Key::kCount) {
          return PlatformError::kNotSupported;
        }
        const bool down = event.kind == InputKind::kKeyDown;
        const auto active = std::span{pressed_}.first(pressed_count_);
        if (down && std::ranges::find(active, PressIdentity{event.key}) != active.end()) {
          RD_ASSERT_MSG(false, "duplicate key press");
          return PlatformError::kInternal;
        }
        const PressChange change{event.key, down ? PressAction::kDown : PressAction::kUp};
        return submit_changes(std::span{&change, 1});
      }
      case InputKind::kButtonDown:
      case InputKind::kButtonUp: {
        if (event.button > MouseButton::kMiddle) {
          return PlatformError::kNotSupported;
        }
        const auto action = event.kind == InputKind::kButtonDown ? PressAction::kDown : PressAction::kUp;
        const PressChange change{event.button, action};
        return submit_changes(std::span{&change, 1});
      }
      case InputKind::kText:
        return inject_text(event.text);
      case InputKind::kPointerMove:
      case InputKind::kWheel:
        return backend_->submit_motion(event);
    }
    return PlatformError::kNotSupported;
  }

  PlatformResult<void> InputInjectorWin::inject_text(std::string_view text) noexcept {
    if (text.size() > kMaxTextBytes ||
        !std::ranges::all_of(text, [](char ch) { return ch >= 0x20 && ch <= 0x7e; })) {
      return PlatformError::kNotSupported;
    }
    if (text.empty()) {
      return std::monostate{};
    }

    static_assert(2 * kMaxTextBytes == kMaxInputPackets);
    std::size_t used = 0;
    for (const char ch : text) {
      const auto unit = static_cast<char16_t>(ch);
      text_changes_[used++] = {unit, PressAction::kDown};
      text_changes_[used++] = {unit, PressAction::kUp};
    }
    return submit_changes(std::span{text_changes_}.first(used));
  }

  PlatformResult<void> InputInjectorWin::submit_changes(
      std::span<const PressChange> changes) noexcept {
    const auto result = backend_->submit(changes);
    if (result.accepted == changes.size()) {
      for (const auto& change : changes) {
        record_change(change);
      }
      return std::monostate{};
    }

    if (result.prefix_confirmed && result.accepted < changes.size()) {
      for (const auto& change : changes.first(result.accepted)) {
        record_change(change);
      }
    } else {
      for (const auto& change : changes) {
        if (change.action == PressAction::kDown) {
          record_change(change);
        }
      }
    }
    return injection_error(backend_->desktop_state());
  }

  void InputInjectorWin::record_change(const PressChange& change) noexcept {
    for (std::size_t i = 0; i < pressed_count_; ++i) {
      if (pressed_[i] == change.identity) {
        if (change.action == PressAction::kUp) {
          erase_press(i);
        }
        return;
      }
    }
    if (change.action == PressAction::kDown) {
      RD_ASSERT(pressed_count_ < pressed_.size());
      pressed_[pressed_count_++] = change.identity;
    }
  }

  void InputInjectorWin::erase_press(std::size_t index) noexcept {
    const auto active = std::span{pressed_}.first(pressed_count_);
    std::ranges::move(active.subspan(index + 1), &pressed_[index]);
    --pressed_count_;
  }

  PlatformResult<void> InputInjectorWin::release_all_pressed() noexcept {
    while (pressed_count_ != 0) {
      if (backend_->desktop_state() != DesktopState::kInteractive) {
        return PlatformError::kInputCleanupPending;
      }

      std::size_t index = pressed_count_ - 1;
      for (std::size_t i = pressed_count_; i > 0; --i) {
        if (!is_modifier(pressed_[i - 1])) {
          index = i - 1;
          break;
        }
      }
      const PressChange release{pressed_[index], PressAction::kUp};
      if (backend_->submit(std::span{&release, 1}).accepted != 1) {
        return PlatformError::kInputCleanupPending;
      }
      erase_press(index);
    }
    return std::monostate{};
  }

  std::size_t InputInjectorWin::pressed_count() const noexcept {
    return pressed_count_;
  }
}  // namespace rd::platform::win
