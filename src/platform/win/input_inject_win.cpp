// Windows press bookkeeping against a platform input backend.
// Thread: input only
#include "remotedesktop/platform/win/input_inject_win.h"

#include <algorithm>
#include <chrono>

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
  }  // namespace

  InputInjectorWin::InputInjectorWin() = default;
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

    switch (event.kind) {
      case InputKind::kKeyDown:
      case InputKind::kKeyUp: {
        if (event.key <= Key::kNone || event.key > Key::kBackquote) {
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
        return PlatformError::kNotSupported;
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

    std::array<PressChange, 2 * kMaxTextBytes> changes{};
    std::size_t used = 0;
    for (const char ch : text) {
      const auto unit = static_cast<char16_t>(ch);
      changes[used++] = {unit, PressAction::kDown};
      changes[used++] = {unit, PressAction::kUp};
    }
    return submit_changes(std::span{changes}.first(used));
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
