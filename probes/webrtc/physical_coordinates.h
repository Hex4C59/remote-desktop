#ifndef REMOTE_DESKTOP_PROBE_PHYSICAL_COORDINATES_H_
#define REMOTE_DESKTOP_PROBE_PHYSICAL_COORDINATES_H_

#include <windows.h>

namespace desktop_probe {
// DXGI display bounds and Windows input must use the physical pixel coordinates
// of Desktop Duplication, regardless of the user's display scaling.
class PhysicalCoordinates {
 public:
  PhysicalCoordinates()
      : previous_(SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {}
  ~PhysicalCoordinates() { if (previous_) SetThreadDpiAwarenessContext(previous_); }
  PhysicalCoordinates(const PhysicalCoordinates&) = delete;
  PhysicalCoordinates& operator=(const PhysicalCoordinates&) = delete;
  bool valid() const { return previous_ != nullptr; }

 private:
  DPI_AWARENESS_CONTEXT previous_;
};
}  // namespace desktop_probe
#endif
