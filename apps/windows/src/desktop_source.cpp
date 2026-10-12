#include "remote_desktop_probe/frame_source.h"
#include "remote_desktop_probe/physical_coordinates.h"

#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstdint>
#include <iostream>

#include "third_party/libyuv/include/libyuv/convert.h"
#include "third_party/libyuv/include/libyuv/rotate.h"
#include "third_party/libyuv/include/libyuv/scale.h"

namespace desktop_probe {
namespace {
using Microsoft::WRL::ComPtr;

bool Failed(const char* operation, HRESULT result) {
  std::cerr << "desktop_error=" << operation << " hresult=0x" << std::hex
            << static_cast<unsigned long>(result) << std::dec << std::endl;
  return false;
}

// Ensures every successful AcquireNextFrame is paired on all return paths.
class AcquiredFrame {
 public:
  explicit AcquiredFrame(IDXGIOutputDuplication* duplication) : duplication_(duplication) {}
  ~AcquiredFrame() { if (duplication_) duplication_->ReleaseFrame(); }
  HRESULT Release() {
    auto* duplication = duplication_;
    duplication_ = nullptr;
    return duplication->ReleaseFrame();
  }
  AcquiredFrame(const AcquiredFrame&) = delete;
  AcquiredFrame& operator=(const AcquiredFrame&) = delete;
 private:
  IDXGIOutputDuplication* duplication_;
};

class DesktopSource final : public FrameSource {
 public:
  bool Initialize() override {
    PhysicalCoordinates physical;
    if (!physical.valid()) {
      return Failed("SetThreadDpiAwarenessContext", HRESULT_FROM_WIN32(GetLastError()));
    }
    DWORD session = 0;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), &session)) {
      return Failed("ProcessIdToSessionId", HRESULT_FROM_WIN32(GetLastError()));
    }
    if (session == 0) {
      std::cerr << "desktop_error=interactive_session_required" << std::endl;
      return false;
    }
    ComPtr<IDXGIFactory1> factory;
    HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(hr)) return Failed("CreateDXGIFactory1", hr);
    for (UINT adapter_index = 0;; ++adapter_index) {
      ComPtr<IDXGIAdapter1> adapter;
      hr = factory->EnumAdapters1(adapter_index, &adapter);
      if (hr == DXGI_ERROR_NOT_FOUND) break;
      if (FAILED(hr)) return Failed("EnumAdapters1", hr);
      for (UINT output_index = 0;; ++output_index) {
        ComPtr<IDXGIOutput> output;
        hr = adapter->EnumOutputs(output_index, &output);
        if (hr == DXGI_ERROR_NOT_FOUND) break;
        if (FAILED(hr)) return Failed("EnumOutputs", hr);
        DXGI_OUTPUT_DESC description{};
        hr = output->GetDesc(&description);
        if (FAILED(hr)) return Failed("GetDesc", hr);
        if (!description.AttachedToDesktop) continue;
        const RECT& bounds = description.DesktopCoordinates;
        bounds_ = DesktopBounds{static_cast<int>(bounds.left), static_cast<int>(bounds.top),
                                static_cast<int>(bounds.right - bounds.left),
                                static_cast<int>(bounds.bottom - bounds.top)};
        hr = D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                              D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                              D3D11_SDK_VERSION, &device_, nullptr, &context_);
        if (FAILED(hr)) return Failed("D3D11CreateDevice", hr);
        ComPtr<IDXGIOutput1> output1;
        hr = output.As(&output1);
        if (FAILED(hr)) return Failed("IDXGIOutput1", hr);
        hr = output1->DuplicateOutput(device_.Get(), &duplication_);
        if (FAILED(hr)) return Failed("DuplicateOutput", hr);
        DXGI_OUTDUPL_DESC mode{};
        duplication_->GetDesc(&mode);
        switch (mode.Rotation) {
          case DXGI_MODE_ROTATION_IDENTITY: rotation_ = libyuv::kRotate0; break;
          case DXGI_MODE_ROTATION_ROTATE90: rotation_ = libyuv::kRotate90; break;
          case DXGI_MODE_ROTATION_ROTATE180: rotation_ = libyuv::kRotate180; break;
          case DXGI_MODE_ROTATION_ROTATE270: rotation_ = libyuv::kRotate270; break;
          default: return Failed("UnsupportedRotation", E_FAIL);
        }
        std::cout << "source=desktop process_session=" << session
                  << " adapter=" << adapter_index << " output=" << output_index
                  << " rotation=" << static_cast<int>(rotation_)
                  << " target_max_width=1280 target_max_height=720"
                  << " pointer_overlay=not_composited" << std::endl;
        std::cout << "desktop_bounds left=" << bounds_->left << " top=" << bounds_->top
                  << " width=" << bounds_->width << " height=" << bounds_->height << std::endl;
        return true;
      }
    }
    return Failed("NoAttachedOutput", DXGI_ERROR_NOT_FOUND);
  }

  std::optional<DesktopBounds> InputBounds() const override { return bounds_; }

  bool Capture(webrtc::scoped_refptr<webrtc::I420Buffer>& latest, CaptureTiming* timing) override {
    DXGI_OUTDUPL_FRAME_INFO info{};
    ComPtr<IDXGIResource> resource;
    if (timing) {
      timing->frame_id = frame_id_;
      timing->acquire_status = "failed";
      const bool swap = rotation_ == libyuv::kRotate90 || rotation_ == libyuv::kRotate270;
      timing->source_width = swap ? texture_height_ : texture_width_;
      timing->source_height = swap ? texture_width_ : texture_height_;
    }
    TimedStage acquire(timing ? &timing->acquire_ns : nullptr);
    HRESULT hr = duplication_->AcquireNextFrame(0, &info, &resource);
    acquire.Stop();
    // Static desktops yield no new texture. Keep the last immutable image and
    // submit it at the sender cadence; this also permits retransmission/keyframes.
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
      if (timing) {
        timing->outcome = latest ? "reused" : "empty";
        timing->acquire_status = "timeout";
      }
      return true;
    }
    if (FAILED(hr)) return Failed("AcquireNextFrame", hr);
    if (timing) timing->acquire_status = "acquired";
    AcquiredFrame acquired(duplication_.Get());
    ComPtr<ID3D11Texture2D> texture;
    hr = resource.As(&texture);
    if (FAILED(hr)) return Failed("ID3D11Texture2D", hr);
    D3D11_TEXTURE2D_DESC desc{};
    texture->GetDesc(&desc);
    if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM || !desc.Width || !desc.Height ||
        desc.Width > 16384 || desc.Height > 16384) {
      return Failed("UnsupportedTexture", E_FAIL);
    }
    if (!staging_) {
      desc.Usage = D3D11_USAGE_STAGING;
      desc.BindFlags = 0;
      desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      desc.MiscFlags = 0;
      hr = device_->CreateTexture2D(&desc, nullptr, &staging_);
      if (FAILED(hr)) return Failed("CreateStagingTexture", hr);
      texture_width_ = static_cast<int>(desc.Width);
      texture_height_ = static_cast<int>(desc.Height);
    }
    if (desc.Width != static_cast<UINT>(texture_width_) ||
        desc.Height != static_cast<UINT>(texture_height_)) {
      return Failed("DisplaySizeChangedRestartRequired", E_FAIL);
    }
    TimedStage readback(timing ? &timing->readback_ns : nullptr);
    context_->CopyResource(staging_.Get(), texture.Get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    hr = context_->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &mapped);
    readback.Stop();
    if (FAILED(hr)) return Failed("Map", hr);
    TimedStage convert(timing ? &timing->convert_ns : nullptr);
    auto converted = webrtc::I420Buffer::Create(texture_width_, texture_height_);
    // DXGI BGRA bytes match libyuv's little-endian ARGB memory layout. Respect
    // GPU row padding; the library owns all plane/pointer arithmetic.
    int result = libyuv::ARGBToI420(static_cast<const uint8_t*>(mapped.pData),
        static_cast<int>(mapped.RowPitch), converted->MutableDataY(), converted->StrideY(),
        converted->MutableDataU(), converted->StrideU(),
        converted->MutableDataV(), converted->StrideV(), texture_width_, texture_height_);
    convert.Stop();
    context_->Unmap(staging_.Get(), 0);
    hr = acquired.Release();
    if (FAILED(hr)) return Failed("ReleaseFrame", hr);
    if (result != 0) return Failed("ARGBToI420", E_FAIL);
    const bool swap_dimensions = rotation_ == libyuv::kRotate90 || rotation_ == libyuv::kRotate270;
    const int width = swap_dimensions ? texture_height_ : texture_width_;
    const int height = swap_dimensions ? texture_width_ : texture_height_;
    if (rotation_ != libyuv::kRotate0) {
      TimedStage rotate(timing ? &timing->rotate_ns : nullptr);
      auto rotated = webrtc::I420Buffer::Create(width, height);
      result = libyuv::I420Rotate(converted->DataY(), converted->StrideY(),
          converted->DataU(), converted->StrideU(), converted->DataV(), converted->StrideV(),
          rotated->MutableDataY(), rotated->StrideY(),
          rotated->MutableDataU(), rotated->StrideU(),
          rotated->MutableDataV(), rotated->StrideV(), texture_width_, texture_height_, rotation_);
      if (result != 0) return Failed("I420Rotate", E_FAIL);
      converted = std::move(rotated);
    }
    const double scale = std::min({1.0, 1280.0 / width, 720.0 / height});
    const int output_width = std::max(2, static_cast<int>(width * scale) & ~1);
    const int output_height = std::max(2, static_cast<int>(height * scale) & ~1);
    TimedStage scale_stage(timing ? &timing->scale_ns : nullptr);
    auto output = webrtc::I420Buffer::Create(output_width, output_height);
    result = libyuv::I420Scale(converted->DataY(), converted->StrideY(),
        converted->DataU(), converted->StrideU(), converted->DataV(), converted->StrideV(),
        width, height, output->MutableDataY(), output->StrideY(),
        output->MutableDataU(), output->StrideU(), output->MutableDataV(), output->StrideV(),
        output_width, output_height, libyuv::kFilterBox);
    scale_stage.Stop();
    if (result != 0) return Failed("I420Scale", E_FAIL);
    if (!latest) {
      std::cout << "desktop_frame=true capture_width=" << width << " capture_height=" << height
                << " output_width=" << output_width << " output_height=" << output_height
                << " conversion=BGRA-I420 scale_filter=box" << std::endl;
    }
    latest = std::move(output);
    ++frame_id_;
    if (timing) { timing->outcome = "fresh"; timing->frame_id = frame_id_; }
    return true;
  }
 private:
  std::optional<DesktopBounds> bounds_;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<IDXGIOutputDuplication> duplication_;
  ComPtr<ID3D11Texture2D> staging_;
  uint64_t frame_id_ = 0;
  int texture_width_ = 0;
  int texture_height_ = 0;
  libyuv::RotationMode rotation_ = libyuv::kRotate0;
};
}  // namespace
std::unique_ptr<FrameSource> CreateDesktopSource() {
  return std::make_unique<DesktopSource>();
}
}  // namespace desktop_probe
