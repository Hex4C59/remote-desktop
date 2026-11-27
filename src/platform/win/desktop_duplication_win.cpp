// Native desktop duplication and staging texture.
// Thread: capture only
#include "remotedesktop/platform/win/screen_capture_win.h"

#include <algorithm>
#include <limits>
#include <utility>

#include <d3d11.h>
#include <dxgi1_2.h>
#if defined(RD_WINDOWS_CAPTURE_DIAGNOSTICS)
#include <dxgi1_3.h>
#endif
#include <shellscalingapi.h>
#include <windows.h>
#include <wrl/client.h>

namespace rd::platform::win {
  namespace {
    using Microsoft::WRL::ComPtr;

#if defined(RD_WINDOWS_CAPTURE_DIAGNOSTICS)
    template <typename T, std::size_t N>
    HRESULT name_resource(T* object, const char (&name)[N]) noexcept {
      return object->SetPrivateData(WKPDID_D3DDebugObjectName,
                                   static_cast<UINT>(N - 1), name);
    }
#endif

    PlatformError capture_error(HRESULT result) noexcept {
      switch (result) {
        case DXGI_ERROR_WAIT_TIMEOUT:
        case DXGI_ERROR_WAS_STILL_DRAWING:
          return PlatformError::kTimeout;
        case DXGI_ERROR_ACCESS_LOST:
          return PlatformError::kAccessLost;
        case DXGI_ERROR_SESSION_DISCONNECTED:
          return PlatformError::kSessionNotInteractive;
        case E_ACCESSDENIED:
          return PlatformError::kPermissionDenied;
        case DXGI_ERROR_UNSUPPORTED:
          return PlatformError::kNotSupported;
        case DXGI_ERROR_NOT_FOUND:
        case DXGI_ERROR_NOT_CURRENTLY_AVAILABLE:
        case DXGI_ERROR_DEVICE_REMOVED:
        case DXGI_ERROR_DEVICE_RESET:
          return PlatformError::kUnavailable;
        default:
          return PlatformError::kInternal;
      }
    }

    PlatformResult<std::uint16_t> monitor_dpi(HMONITOR monitor) noexcept {
      UINT x = 0;
      UINT y = 0;
      const auto result = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &x, &y);
      if (FAILED(result) || x == 0 ||
          x > (std::numeric_limits<std::uint16_t>::max)()) {
        return PlatformError::kUnavailable;
      }
      return static_cast<std::uint16_t>(x);
    }

    struct MonitorSize {
      std::uint32_t width;
      std::uint32_t height;
    };

    std::optional<MonitorSize> monitor_pixel_size(HMONITOR monitor) noexcept {
      // Query monitor bounds in physical pixels without enumerating modes.
      auto previous = SetThreadDpiAwarenessContext(
          DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
      if (previous == nullptr) {
        previous = SetThreadDpiAwarenessContext(
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE);
      }
      if (previous == nullptr) {
        return std::nullopt;
      }
      MONITORINFO info{};
      info.cbSize = sizeof(info);
      const auto found = GetMonitorInfoW(monitor, &info);
      SetThreadDpiAwarenessContext(previous);
      if (!found || info.rcMonitor.right <= info.rcMonitor.left ||
          info.rcMonitor.bottom <= info.rcMonitor.top) {
        return std::nullopt;
      }
      return MonitorSize{static_cast<std::uint32_t>(
                             static_cast<std::int64_t>(info.rcMonitor.right) -
                             info.rcMonitor.left),
                         static_cast<std::uint32_t>(
                             static_cast<std::int64_t>(info.rcMonitor.bottom) -
                             info.rcMonitor.top)};
    }

    HRESULT find_primary_output(ComPtr<IDXGIAdapter1>& adapter,
                                ComPtr<IDXGIOutput1>& output,
                                HMONITOR& monitor) noexcept {
      ComPtr<IDXGIFactory1> factory;
      // The COM API takes an interface ID and a type-erased output pointer.
#if defined(RD_WINDOWS_CAPTURE_DIAGNOSTICS)
      auto result = CreateDXGIFactory2(
          DXGI_CREATE_FACTORY_DEBUG, IID_IDXGIFactory1,
          reinterpret_cast<void**>(factory.GetAddressOf()));
#else
      auto result = CreateDXGIFactory1(
          IID_IDXGIFactory1, reinterpret_cast<void**>(factory.GetAddressOf()));
#endif
      if (FAILED(result)) {
        return result;
      }
      for (UINT a = 0;; ++a) {
        result = factory->EnumAdapters1(a, adapter.ReleaseAndGetAddressOf());
        if (FAILED(result)) {
          return result;
        }
        for (UINT o = 0;; ++o) {
          ComPtr<IDXGIOutput> candidate;
          result = adapter->EnumOutputs(o, candidate.GetAddressOf());
          if (result == DXGI_ERROR_NOT_FOUND) {
            break;
          }
          if (FAILED(result)) {
            return result;
          }
          DXGI_OUTPUT_DESC desc{};
          result = candidate->GetDesc(&desc);
          if (FAILED(result)) {
            return result;
          }
          if (desc.AttachedToDesktop && desc.DesktopCoordinates.left == 0 &&
              desc.DesktopCoordinates.top == 0) {
            monitor = desc.Monitor;
            return candidate.As(&output);
          }
        }
      }
    }

    class DesktopDuplication final : public CaptureBackend {
     public:
      PlatformResult<CaptureLayout> initialize(
          const CaptureConfig& config) noexcept override {
        ComPtr<IDXGIAdapter1> adapter;
        ComPtr<IDXGIOutput1> output;
        HMONITOR monitor = nullptr;
        auto result = find_primary_output(adapter, output, monitor);
        if (FAILED(result)) {
          return capture_error(result);
        }
        const auto dpi_result = monitor_dpi(monitor);
        const auto* dpi = std::get_if<std::uint16_t>(&dpi_result);
        if (dpi == nullptr) {
          return std::get<PlatformError>(dpi_result);
        }

        ComPtr<ID3D11Device> device;
        ComPtr<ID3D11DeviceContext> context;
        // Request no driver workers for this Capture-owned, copy-only device.
        // Hardware drivers may ignore the request; native acceptance verifies
        // both private-memory growth and the cost of command submission.
        constexpr UINT kDeviceFlags =
            D3D11_CREATE_DEVICE_SINGLETHREADED |
            D3D11_CREATE_DEVICE_PREVENT_INTERNAL_THREADING_OPTIMIZATIONS
#if defined(RD_WINDOWS_CAPTURE_DIAGNOSTICS)
            | D3D11_CREATE_DEVICE_DEBUG
#endif
            ;
        result = D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN,
                                   nullptr, kDeviceFlags, nullptr, 0,
                                   D3D11_SDK_VERSION, device.GetAddressOf(),
                                   nullptr, context.GetAddressOf());
        if (FAILED(result)) {
          return capture_error(result);
        }
        ComPtr<IDXGIOutputDuplication> duplication;
        result =
            output->DuplicateOutput(device.Get(), duplication.GetAddressOf());
        if (FAILED(result)) {
          return capture_error(result);
        }
        DXGI_OUTDUPL_DESC desc{};
        duplication->GetDesc(&desc);
        const auto width = desc.ModeDesc.Width;
        const auto height = desc.ModeDesc.Height;
        if (desc.Rotation != DXGI_MODE_ROTATION_IDENTITY ||
            desc.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM ||
            (config.requested_width != 0 && config.requested_width != width) ||
            (config.requested_height != 0 &&
             config.requested_height != height)) {
          return PlatformError::kNotSupported;
        }
        if (width == 0 || height == 0) {
          return PlatformError::kUnavailable;
        }

        D3D11_TEXTURE2D_DESC texture{};
        texture.Width = width;
        texture.Height = height;
        texture.MipLevels = 1;
        texture.ArraySize = 1;
        texture.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        texture.SampleDesc.Count = 1;
        texture.Usage = D3D11_USAGE_STAGING;
        texture.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        ComPtr<ID3D11Texture2D> staging;
        result =
            device->CreateTexture2D(&texture, nullptr, staging.GetAddressOf());
        if (FAILED(result)) {
          return capture_error(result);
        }
        ComPtr<ID3D11Query> completion;
        const D3D11_QUERY_DESC query{D3D11_QUERY_EVENT, 0};
        result = device->CreateQuery(&query, completion.GetAddressOf());
        if (FAILED(result)) {
          return capture_error(result);
        }
#if defined(RD_WINDOWS_CAPTURE_DIAGNOSTICS)
        if (FAILED(name_resource(device.Get(), "rd.capture.device")) ||
            FAILED(name_resource(context.Get(), "rd.capture.context")) ||
            FAILED(name_resource(duplication.Get(), "rd.capture.duplication")) ||
            FAILED(name_resource(staging.Get(), "rd.capture.staging")) ||
            FAILED(name_resource(completion.Get(), "rd.capture.completion"))) {
          return PlatformError::kInternal;
        }
#endif
        // Determine the pitch once so a descriptor-only probe does not copy or
        // map a frame.
        D3D11_MAPPED_SUBRESOURCE mapped{};
        result = context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
        if (FAILED(result)) {
          return capture_error(result);
        }
        context->Unmap(staging.Get(), 0);

        context_ = std::move(context);
        duplication_ = std::move(duplication);
        staging_ = std::move(staging);
        completion_ = std::move(completion);
        monitor_ = monitor;
        staging_desc_ = texture;
        stride_ = mapped.RowPitch;
        return CaptureLayout{width, height, stride_, *dpi};
      }

      std::optional<CaptureLayout> observed_display_change(
          const DisplayInfo& current) noexcept override {
        const auto monitor =
            MonitorFromPoint(POINT{}, MONITOR_DEFAULTTOPRIMARY);
        const auto size = monitor_pixel_size(monitor);
        const auto width = size ? size->width : current.width;
        const auto height = size ? size->height : current.height;
        const auto dpi_result = monitor_dpi(monitor);
        const auto* observed_dpi = std::get_if<std::uint16_t>(&dpi_result);
        const auto dpi = observed_dpi != nullptr ? *observed_dpi : current.dpi;
        if (width == current.width && height == current.height &&
            dpi == current.dpi) {
          return std::nullopt;
        }
        return CaptureLayout{width, height, width * 4, dpi};
      }

      PlatformResult<CaptureSample> acquire(
          std::uint32_t timeout_ms) noexcept override {
        if (release_error_) {
          return *release_error_;
        }
        DXGI_OUTDUPL_FRAME_INFO info{};
        ComPtr<IDXGIResource> resource;
        const auto result = duplication_->AcquireNextFrame(
            timeout_ms, &info, resource.GetAddressOf());
        if (FAILED(result)) {
          return capture_error(result);
        }
        const auto timestamp = now_ns();
        const auto texture_result = resource.As(&frame_);
        if (FAILED(texture_result)) {
          return discard_frame(capture_error(texture_result));
        }
        frame_->GetDesc(&frame_desc_);
        if (frame_desc_.Format != staging_desc_.Format ||
            frame_desc_.SampleDesc.Count != 1) {
          return discard_frame(PlatformError::kNotSupported);
        }
        const auto dpi_result = monitor_dpi(monitor_);
        const auto* dpi = std::get_if<std::uint16_t>(&dpi_result);
        if (dpi == nullptr) {
          return discard_frame(std::get<PlatformError>(dpi_result));
        }
        const auto row_bytes = frame_desc_.Width * 4;
        return CaptureSample{{frame_desc_.Width, frame_desc_.Height,
                              (std::max)(stride_, row_bytes), *dpi},
                             timestamp};
      }

      PlatformResult<void> submit_readback() noexcept override {
        if (frame_desc_.Width > staging_desc_.Width ||
            frame_desc_.Height > staging_desc_.Height) {
          // The new mode cannot fit in the staging texture allocated at
          // initialization.
          return PlatformError::kDisplayChanged;
        }
        const D3D11_BOX region{0, 0, 0, frame_desc_.Width, frame_desc_.Height,
                               1};
        context_->CopySubresourceRegion(staging_.Get(), 0, 0, 0, 0,
                                        frame_.Get(), 0, &region);
        context_->End(completion_.Get());
        // Submit commands before releasing the source. Completion is polled
        // separately.
        context_->Flush();
        readback_height_ = frame_desc_.Height;
        return std::monostate{};
      }

      PlatformResult<void> poll_readback() noexcept override {
        const auto result = context_->GetData(completion_.Get(), nullptr, 0,
                                              D3D11_ASYNC_GETDATA_DONOTFLUSH);
        if (result == S_OK) {
          return std::monostate{};
        }
        if (result == S_FALSE) {
          return PlatformError::kTimeout;
        }
        return capture_error(result);
      }

      PlatformResult<MappedCapture> map_pixels() noexcept override {
        D3D11_MAPPED_SUBRESOURCE mapped{};
        const auto result = context_->Map(staging_.Get(), 0, D3D11_MAP_READ,
                                          D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
        if (FAILED(result)) {
          return capture_error(result);
        }
        stride_ = mapped.RowPitch;
        const auto size = static_cast<std::size_t>(stride_) * readback_height_;
        return MappedCapture{
            {static_cast<const std::byte*>(mapped.pData), size}, stride_};
      }

      void unmap_pixels() noexcept override {
        context_->Unmap(staging_.Get(), 0);
      }

      PlatformResult<void> release_frame() noexcept override {
        frame_.Reset();
        const auto result = duplication_->ReleaseFrame();
        if (FAILED(result)) {
          release_error_ = capture_error(result);
          return *release_error_;
        }
        return std::monostate{};
      }

     private:
      PlatformError discard_frame(PlatformError error) noexcept {
        const auto result = release_frame();
        const auto* release_error = std::get_if<PlatformError>(&result);
        return release_error == nullptr ? error : *release_error;
      }

      ComPtr<ID3D11DeviceContext> context_;
      ComPtr<IDXGIOutputDuplication> duplication_;
      ComPtr<ID3D11Texture2D> staging_;
      ComPtr<ID3D11Query> completion_;
      ComPtr<ID3D11Texture2D> frame_;
      D3D11_TEXTURE2D_DESC staging_desc_{};
      D3D11_TEXTURE2D_DESC frame_desc_{};
      HMONITOR monitor_{};
      std::optional<PlatformError> release_error_;
      std::uint32_t readback_height_{};
      std::uint32_t stride_{};
    };
  }  // namespace

  std::unique_ptr<CaptureBackend> make_desktop_duplication() {
    return std::make_unique<DesktopDuplication>();
  }
}  // namespace rd::platform::win
