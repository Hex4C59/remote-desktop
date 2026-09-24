#ifndef REMOTE_DESKTOP_PROBE_FRAME_SOURCE_H_
#define REMOTE_DESKTOP_PROBE_FRAME_SOURCE_H_

#include <memory>
#include <optional>

#include "api/scoped_refptr.h"
#include "api/video/i420_buffer.h"

namespace desktop_probe {
struct DesktopBounds {
  int left, top, width, height;
};
// Construct, initialize, capture and destroy on the sender's capture thread.
// Capture replaces latest only when a new image exists; false is a fatal error.
// No work is posted or queued here. The caller keeps one latest immutable frame.
class FrameSource {
 public:
  virtual ~FrameSource() = default;
  virtual bool Initialize() = 0;
  virtual bool Capture(webrtc::scoped_refptr<webrtc::I420Buffer>& latest) = 0;
  // Physical desktop rectangle of the selected, already-rotated output.
  // Synthetic sources do not permit input.
  virtual std::optional<DesktopBounds> InputBounds() const { return std::nullopt; }
};

std::unique_ptr<FrameSource> CreatePatternSource();
#if defined(WEBRTC_WIN)
std::unique_ptr<FrameSource> CreateDesktopSource();
#endif
}  // namespace desktop_probe
#endif
