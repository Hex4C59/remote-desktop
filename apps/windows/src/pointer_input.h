#ifndef REMOTE_DESKTOP_PROBE_POINTER_INPUT_H_
#define REMOTE_DESKTOP_PROBE_POINTER_INPUT_H_

#include <string_view>

#include "remote_desktop_probe/frame_source.h"

namespace desktop_probe {
// Owned and called only on the capture thread. A click carries its own release;
// no remote message is allowed to hold a button across a network round trip.
class PointerInput {
 public:
  explicit PointerInput(DesktopBounds bounds) : bounds_(bounds) {}
  ~PointerInput();
  PointerInput(const PointerInput&) = delete;
  PointerInput& operator=(const PointerInput&) = delete;
  bool Click(std::string_view message);

 private:
  bool Release();
  DesktopBounds bounds_;
  bool release_pending_ = false;
};
}  // namespace desktop_probe
#endif
