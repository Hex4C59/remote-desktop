// Windows input injector and its press-report test seam.
// Thread: input only
#pragma once

#include <array>
#include <cstddef>
#include <memory>
#include <span>
#include <variant>

#include "remotedesktop/platform/win/desktop_state_reader.h"

namespace rd::platform::win {

  using PressIdentity = std::variant<Key, MouseButton, char16_t>;
  enum class PressAction { kDown, kUp };

  struct PressChange {
    PressIdentity identity;
    PressAction action;

    bool operator==(const PressChange&) const = default;
  };

  struct InputBatchResult {
    std::size_t accepted;
    bool prefix_confirmed;  // A zero without confirmation may also indicate unknown effects.
  };

  // The system adapter translates these packets one-for-one into the native
  // input ABI.
  enum class InputPacketKind { kMouse, kKeyboard };

  struct InputPacket {
    InputPacketKind kind{InputPacketKind::kMouse};
    std::uint32_t flags{};
    std::int32_t x{};
    std::int32_t y{};
    std::int32_t wheel_delta{};
    std::uint16_t virtual_key{};
    std::uint16_t scan_code{};

    bool operator==(const InputPacket&) const = default;
  };

  struct VirtualDesktopBounds {
    std::int32_t x{};
    std::int32_t y{};
    std::int32_t width{};
    std::int32_t height{};
  };

  struct InputSystemWin {
    std::size_t (*submit)(void*, std::span<const InputPacket>) noexcept {};
    VirtualDesktopBounds (*bounds)(void*) noexcept {};
    void* context{};
  };

  class InputPressBackend {
   public:
    virtual InputBatchResult submit(std::span<const PressChange>) noexcept = 0;
    virtual PlatformResult<void> submit_motion(const InputEvent&) noexcept {
      return PlatformError::kNotSupported;
    }
    virtual DesktopState desktop_state() const noexcept = 0;
    virtual ~InputPressBackend() = default;
  };

  class InputInjectorWin final : public InputInjector {
   public:
    InputInjectorWin();
    explicit InputInjectorWin(DesktopStateReader desktop);
    // Test seam for the final system dispatch. The caller owns both callback
    // contexts.
    InputInjectorWin(InputSystemWin system, DesktopStateReader desktop);
    explicit InputInjectorWin(InputPressBackend& backend) noexcept;
    ~InputInjectorWin() override;

    PlatformResult<void> inject(InputEvent&) noexcept override;
    [[nodiscard]] PlatformResult<void> release_all_pressed() noexcept override;
    std::size_t pressed_count() const noexcept;

    InputInjectorWin(const InputInjectorWin&) = delete;
    InputInjectorWin& operator=(const InputInjectorWin&) = delete;

   private:
    static constexpr std::size_t kPressedCapacity =
        static_cast<std::size_t>(Key::kCount) - 1 + 3 + (0x7e - 0x20 + 1);
    static constexpr std::size_t kMaxTextBytes = 256;

    PlatformResult<void> inject_text(std::string_view text) noexcept;
    PlatformResult<void> submit_changes(std::span<const PressChange> changes) noexcept;
    void record_change(const PressChange& change) noexcept;
    void erase_press(std::size_t index) noexcept;

    std::unique_ptr<InputPressBackend> owned_backend_;
    InputPressBackend* backend_{};
    std::array<PressIdentity, kPressedCapacity> pressed_{};
    std::array<PressChange, 2 * kMaxTextBytes> text_changes_{};
    std::size_t pressed_count_{};
  };

}  // namespace rd::platform::win
