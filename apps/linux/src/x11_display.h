#ifndef REMOTE_DESKTOP_LINUX_X11_DISPLAY_H_
#define REMOTE_DESKTOP_LINUX_X11_DISPLAY_H_
#include "remote_desktop_probe/frame_source.h"
#include <X11/Xlib.h>
#include <X11/extensions/Xrandr.h>
#include <optional>
#include <span>

namespace desktop_probe {
struct X11Monitor {
  Atom id;
  DesktopBounds bounds;
  bool operator==(const X11Monitor& other) const {
    return id == other.id && bounds.left == other.bounds.left && bounds.top == other.bounds.top &&
           bounds.width == other.bounds.width && bounds.height == other.bounds.height;
  }
};
inline std::optional<X11Monitor> PrimaryMonitor(Display* display) {
  if (!display) return std::nullopt;
  int count = 0;
  XRRMonitorInfo* monitors = XRRGetMonitors(display, XDefaultRootWindow(display), True, &count);
  if (!monitors || count <= 0) { if (monitors) XRRFreeMonitors(monitors); return std::nullopt; }
  // Native XRandR returns count readable records. Keep this C ABI boundary small.
#pragma clang unsafe_buffer_usage begin
  const std::span<XRRMonitorInfo> entries(monitors, static_cast<size_t>(count));
#pragma clang unsafe_buffer_usage end
  const XRRMonitorInfo* selected = &entries.front();
  for (const auto& monitor : entries) { if (monitor.primary) { selected = &monitor; break; } }
  X11Monitor result{selected->name,
                    {selected->x, selected->y, selected->width, selected->height}};
  XRRFreeMonitors(monitors);
  if (result.bounds.width <= 0 || result.bounds.height <= 0) return std::nullopt;
  return result;
}
}  // namespace desktop_probe
#endif
