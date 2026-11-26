// Windows input injector and its press-report test seam.
// Thread: input only
#pragma once

#include <array>
#include <cstddef>
#include <span>
#include <variant>

#include "remotedesktop/platform/platform.h"

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

  class InputPressBackend {
   public:
    virtual InputBatchResult submit(std::span<const PressChange>) noexcept = 0;
    virtual DesktopState desktop_state() const noexcept = 0;
    virtual ~InputPressBackend() = default;
  };

  class InputInjectorWin final : public InputInjector {
   public:
    InputInjectorWin();
    explicit InputInjectorWin(InputPressBackend& backend) noexcept;
    ~InputInjectorWin() override;

    PlatformResult<void> inject(InputEvent&) noexcept override;
    [[nodiscard]] PlatformResult<void> release_all_pressed() noexcept override;
    std::size_t pressed_count() const noexcept;

    InputInjectorWin(const InputInjectorWin&) = delete;
    InputInjectorWin& operator=(const InputInjectorWin&) = delete;

   private:
    static constexpr std::size_t kPressedCapacity =
        static_cast<std::size_t>(Key::kBackquote) + 3 + (0x7e - 0x20 + 1);
    static constexpr std::size_t kMaxTextBytes = 256;

    PlatformResult<void> inject_text(std::string_view text) noexcept;
    PlatformResult<void> submit_changes(std::span<const PressChange> changes) noexcept;
    void record_change(const PressChange& change) noexcept;
    void erase_press(std::size_t index) noexcept;

    InputPressBackend* backend_{};
    std::array<PressIdentity, kPressedCapacity> pressed_{};
    std::size_t pressed_count_{};
  };

}  // namespace rd::platform::win
