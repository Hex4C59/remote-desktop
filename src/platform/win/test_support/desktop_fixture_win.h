// Native window and display controls for the interactive acceptance program.
// Thread: ui only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>

namespace rd::platform::win::test {
  struct Point {
    std::int32_t x{};
    std::int32_t y{};
    bool operator==(const Point&) const = default;
  };

  struct WindowInput {
    Point mouse_down_at;
    Point mouse_up_at;
    std::uint32_t mouse_downs{};
    std::uint32_t mouse_ups{};
    std::uint32_t key_downs{};
    std::uint32_t key_ups{};
    std::string text;
    bool close_requested{};
  };

  struct DisplayMode {
    std::uint32_t width{};
    std::uint32_t height{};
    std::uint32_t refresh_hz{};
    bool operator==(const DisplayMode&) const = default;
  };

  enum class WindowUse { kCapture, kInput };

  class DesktopWindow {
   public:
    explicit DesktopWindow(const wchar_t* title,
                           WindowUse use = WindowUse::kCapture);
    ~DesktopWindow();
    bool ready() const noexcept;
    bool stays_passive_on_click() const noexcept;
    void activate() noexcept;
    bool focused() const noexcept;
    void paint(std::uint32_t rgb) noexcept;
    std::optional<Point> screen_point(Point client_point) const noexcept;
    bool owns_screen_point(Point point) const noexcept;
    std::uint32_t dpi() const noexcept;
    void pump() noexcept;
    bool post_close() noexcept;
    void clear_input() noexcept;
    const WindowInput& input() const noexcept;

   private:
    struct Window;
    std::unique_ptr<Window> window_;
  };

  // Changes the primary mode for this run and restores the original on exit.
  class TemporaryDisplayMode {
   public:
    TemporaryDisplayMode();
    ~TemporaryDisplayMode();
    bool change_to_smaller_mode() noexcept;
    bool restore() noexcept;
    std::int32_t change_status() const noexcept;

   private:
    struct Modes;
    std::unique_ptr<Modes> modes_;
  };

  std::optional<DisplayMode> current_display_mode() noexcept;
  std::uint32_t primary_monitor_dpi() noexcept;
  std::optional<Point> physical_cursor() noexcept;
  Point virtual_desktop_size() noexcept;
  std::optional<std::uint64_t> private_bytes() noexcept;

  struct HeapFootprint {
    std::uintptr_t id{};
    std::uint64_t allocated{};
    std::uint64_t committed{};
    bool process_heap{};
  };

  struct MemoryFootprint {
    static constexpr std::size_t kMaxHeaps = 128;
    std::array<HeapFootprint, kMaxHeaps> heaps{};
    std::uint64_t private_commit{};
    std::uint64_t heap_allocated{};
    std::uint64_t heap_committed{};
    std::uint32_t heap_count{};
    std::uint32_t heaps_sampled{};
    std::uint32_t gdi_objects{};
    std::uint32_t user_objects{};
  };

  std::optional<MemoryFootprint> memory_footprint() noexcept;
  std::uint32_t process_id() noexcept;
  bool f8_down() noexcept;
  bool left_button_down() noexcept;
  bool use_physical_pixel_coordinates() noexcept;
}  // namespace rd::platform::win::test
