#ifndef REMOTE_DESKTOP_PROBE_FRAME_SOURCE_H_
#define REMOTE_DESKTOP_PROBE_FRAME_SOURCE_H_

#include <memory>

#include "api/scoped_refptr.h"
#include "api/video/i420_buffer.h"

namespace desktop_probe {
// Construct, initialize, capture and destroy on the sender's capture thread.
// Capture replaces latest only when a new image exists; false is a fatal error.
// No work is posted or queued here. The caller keeps one latest immutable frame.
class FrameSource {
 public:
  virtual ~FrameSource() = default;
  virtual bool Initialize() = 0;
  virtual bool Capture(webrtc::scoped_refptr<webrtc::I420Buffer>& latest) = 0;
};

std::unique_ptr<FrameSource> CreatePatternSource();
#if defined(WEBRTC_WIN)
std::unique_ptr<FrameSource> CreateDesktopSource();
#endif
}  // namespace desktop_probe
#endif
