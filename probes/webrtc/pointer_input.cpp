#include "remote_desktop_probe/pointer_input.h"

#include <windows.h>

#include <array>
#include <charconv>
#include <cstdint>
#include <iostream>

namespace desktop_probe {
namespace {
bool Coordinate(std::string_view text, int& value) {
  if (text.empty() || text.size() > 5) return false;
  const auto parsed = std::from_chars(text.data(), text.substr(text.size()).data(), value);
  return parsed.ec == std::errc() && parsed.ptr == text.substr(text.size()).data() &&
         value >= 0 && value <= 65535;
}

// GetMonitorInfo/GetSystemMetrics must use the same physical coordinates as
// Desktop Duplication, regardless of the user's Windows display scaling.
class PhysicalCoordinates {
 public:
  PhysicalCoordinates()
      : previous_(SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {}
  ~PhysicalCoordinates() { if (previous_) SetThreadDpiAwarenessContext(previous_); }
  bool valid() const { return previous_ != nullptr; }
 private:
  DPI_AWARENESS_CONTEXT previous_;
};
}  // namespace

PointerInput::~PointerInput() {
  if (!Release()) std::cerr << "pointer_release_failed=true" << std::endl;
}

bool PointerInput::Release() {
  if (!release_pending_) return true;
  INPUT release{};
  release.type = INPUT_MOUSE;
  release.mi.dwFlags = MOUSEEVENTF_LEFTUP;
  if (SendInput(1, &release, sizeof(INPUT)) != 1) return false;
  release_pending_ = false;
  return true;
}

bool PointerInput::Click(std::string_view message) {
  constexpr std::string_view prefix = "pointer:click:";
  if (!message.starts_with(prefix)) return false;
  message.remove_prefix(prefix.size());
  const auto separator = message.find(':');
  int x = 0, y = 0;
  if (separator == std::string_view::npos ||
      !Coordinate(message.substr(0, separator), x) ||
      !Coordinate(message.substr(separator + 1), y)) return false;

  PhysicalCoordinates physical;
  if (!physical.valid() || bounds_.width <= 0 || bounds_.height <= 0) return false;
  RECT rect{bounds_.left, bounds_.top, bounds_.left + bounds_.width,
            bounds_.top + bounds_.height};
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfo(MonitorFromRect(&rect, MONITOR_DEFAULTTONULL), &info) ||
      !EqualRect(&rect, &info.rcMonitor)) return false;
  const int virtual_left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const int virtual_top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const int virtual_width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  const int virtual_height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (virtual_width <= 0 || virtual_height <= 0) return false;
  const int desktop_x = bounds_.left + static_cast<int>(
      (int64_t{x} * (bounds_.width - 1) + 32767) / 65535);
  const int desktop_y = bounds_.top + static_cast<int>(
      (int64_t{y} * (bounds_.height - 1) + 32767) / 65535);
  if (desktop_x < virtual_left || desktop_x >= virtual_left + virtual_width ||
      desktop_y < virtual_top || desktop_y >= virtual_top + virtual_height) return false;

  std::array<INPUT, 3> inputs{};
  for (auto& input : inputs) input.type = INPUT_MOUSE;
  // Aim at the pixel centre in Windows' 65536-bin virtual-desktop mapping.
  inputs[0].mi.dx = static_cast<LONG>(
      ((int64_t{desktop_x} - virtual_left) * 65536 + 32768) / virtual_width);
  inputs[0].mi.dy = static_cast<LONG>(
      ((int64_t{desktop_y} - virtual_top) * 65536 + 32768) / virtual_height);
  inputs[0].mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
  inputs[2].mi.dwFlags = MOUSEEVENTF_LEFTUP;
  const UINT sent = SendInput(static_cast<UINT>(inputs.size()), inputs.data(), sizeof(INPUT));
  // A partial batch may have inserted DOWN without UP. Retry the release now,
  // and retain ownership for destructor cleanup if Windows still rejects it.
  release_pending_ = sent == 2;
  if (sent != inputs.size()) {
    Release();
    std::cerr << "pointer_injection_failed=true events=" << sent << std::endl;
    return false;
  }
  std::cout << "pointer_click=true x=" << desktop_x << " y=" << desktop_y << std::endl;
  return true;
}
}  // namespace desktop_probe
