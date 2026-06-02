#include "remote_desktop_probe/frame_source.h"

#include <iostream>

#include "third_party/libyuv/include/libyuv/planar_functions.h"

namespace desktop_probe {
namespace {
class PatternSource final : public FrameSource {
 public:
  bool Initialize() override {
    std::cout << "source=pattern output_width=640 output_height=360" << std::endl;
    return true;
  }
  bool Capture(webrtc::scoped_refptr<webrtc::I420Buffer>& latest) override {
    auto buffer = webrtc::I420Buffer::Create(640, 360);
    webrtc::I420Buffer::SetBlack(buffer.get());
    libyuv::I420Rect(buffer->MutableDataY(), buffer->StrideY(),
                    buffer->MutableDataU(), buffer->StrideU(),
                    buffer->MutableDataV(), buffer->StrideV(),
                    left_, 0, 120, 360, 180, 90, 180);
    left_ = (left_ + 4) % 520;
    latest = std::move(buffer);
    return true;
  }
 private:
  int left_ = 0;
};
}  // namespace
std::unique_ptr<FrameSource> CreatePatternSource() {
  return std::make_unique<PatternSource>();
}
}  // namespace desktop_probe
