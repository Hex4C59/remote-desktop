#include "remote_desktop_probe/desktop_source.h"
#include "api/video/i420_buffer.h"
#include "modules/desktop_capture/desktop_capture_options.h"
#include "modules/desktop_capture/desktop_capturer.h"
#include "modules/desktop_capture/desktop_frame.h"
#include "third_party/libyuv/include/libyuv/convert.h"
#include "third_party/libyuv/include/libyuv/scale.h"
#include "remote_desktop_probe/x11_display.h"
#include <algorithm>
#include <iostream>

namespace desktop_probe {
namespace {
class X11DesktopSource final : public FrameSource, public webrtc::DesktopCapturer::Callback {
 public:
  ~X11DesktopSource() override {
    capturer_.reset();
    if (display_) XCloseDisplay(display_);
  }
  bool Initialize() override {
    display_ = XOpenDisplay(nullptr);
    monitor_ = PrimaryMonitor(display_);
    if (!monitor_) return Failed("monitor_unavailable");
    auto options = webrtc::DesktopCaptureOptions::CreateDefault();
    capturer_ = webrtc::DesktopCapturer::CreateScreenCapturer(options);
    if (!capturer_) return Failed("capturer_unavailable");
    webrtc::DesktopCapturer::SourceList sources;
    if (!capturer_->GetSourceList(&sources)) return Failed("source_list");
    bool found = false;
    for (const auto& source : sources) {
      if (source.id == static_cast<webrtc::DesktopCapturer::SourceId>(monitor_->id)) {
        found = capturer_->SelectSource(source.id); break;
      }
    }
    if (!found) return Failed("primary_source");
    capturer_->Start(this);
    return true;
  }
  std::optional<DesktopBounds> InputBounds() const override {
    return monitor_ ? std::optional(monitor_->bounds) : std::nullopt;
  }
  bool Capture(webrtc::scoped_refptr<webrtc::I420Buffer>& latest,
               CaptureTiming* timing) override {
    if (PrimaryMonitor(display_) != monitor_) return Failed("display_changed");
    captured_ = false;
    frame_.reset();
    capturer_->CaptureFrame();  // The pinned X11 implementation completes synchronously.
    if (!captured_ || result_ == webrtc::DesktopCapturer::Result::ERROR_PERMANENT)
      return Failed("capture_failed");
    if (result_ == webrtc::DesktopCapturer::Result::ERROR_TEMPORARY) return true;
    if (!frame_ || frame_->size().width() != monitor_->bounds.width ||
        frame_->size().height() != monitor_->bounds.height ||
        frame_->top_left().x() != monitor_->bounds.left ||
        frame_->top_left().y() != monitor_->bounds.top) return Failed("frame_bounds");
    const int width = frame_->size().width(), height = frame_->size().height();
    auto converted = webrtc::I420Buffer::Create(width, height);
    if (libyuv::ARGBToI420(frame_->data(), frame_->stride(), converted->MutableDataY(),
          converted->StrideY(), converted->MutableDataU(), converted->StrideU(),
          converted->MutableDataV(), converted->StrideV(), width, height) != 0)
      return Failed("convert");
    const double scale = std::min({1.0, 1280.0 / width, 720.0 / height});
    const int output_width = std::max(2, static_cast<int>(width * scale) & ~1);
    const int output_height = std::max(2, static_cast<int>(height * scale) & ~1);
    if (output_width != width || output_height != height) {
      auto resized = webrtc::I420Buffer::Create(output_width, output_height);
      if (libyuv::I420Scale(converted->DataY(), converted->StrideY(),
            converted->DataU(), converted->StrideU(), converted->DataV(), converted->StrideV(),
            width, height, resized->MutableDataY(), resized->StrideY(),
            resized->MutableDataU(), resized->StrideU(), resized->MutableDataV(),
            resized->StrideV(), output_width, output_height, libyuv::kFilterBox) != 0)
        return Failed("scale");
      converted = std::move(resized);
    }
    latest = std::move(converted);
    frame_.reset();
    if (!reported_) {
      std::cout << "desktop_frame source_width=" << width << " source_height=" << height
                << " width=" << output_width << " height=" << output_height << " source=x11\n";
      reported_ = true;
    }
    if (timing) { timing->outcome = "fresh"; timing->acquire_status = "acquired"; }
    return true;
  }
  void OnCaptureResult(webrtc::DesktopCapturer::Result result,
                       std::unique_ptr<webrtc::DesktopFrame> frame) override {
    result_ = result; frame_ = std::move(frame); captured_ = true;
  }
 private:
  bool Failed(const char* reason) { std::cerr << "desktop_error=" << reason << '\n'; return false; }
  Display* display_ = nullptr;
  std::optional<X11Monitor> monitor_;
  std::unique_ptr<webrtc::DesktopCapturer> capturer_;
  std::unique_ptr<webrtc::DesktopFrame> frame_;
  webrtc::DesktopCapturer::Result result_ = webrtc::DesktopCapturer::Result::ERROR_PERMANENT;
  bool captured_ = false, reported_ = false;
};
}  // namespace
std::unique_ptr<FrameSource> CreateX11DesktopSource() { return std::make_unique<X11DesktopSource>(); }
}  // namespace desktop_probe
