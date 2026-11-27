// Report SDK live objects outside capture calls.
// Thread: none
#include "capture_resource_diagnostics_win.h"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <dxgi1_3.h>
#include <dxgidebug.h>
#include <windows.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdint>
#include <iostream>

namespace rd::platform::win::test {

  bool report_capture_resources(
      const CaptureResourceSnapshot& snapshot) noexcept {
    std::cout << "RD_CAPTURE_REPORT begin cycle=" << snapshot.cycle
              << " phase=" << snapshot.phase << " mode=" << snapshot.mode
              << " attempt=" << snapshot.attempt
              << " elapsed_ns=" << snapshot.elapsed_ns
              << " frames_in_use=" << snapshot.frames_in_use
              << " submitted=" << snapshot.submitted
              << " ready=" << snapshot.ready << std::endl;
    const auto begin = std::chrono::steady_clock::now();
    Microsoft::WRL::ComPtr<IDXGIDebug1> debug;
    // The SDK accepts an IID and a type-erased COM output pointer.
    auto result = DXGIGetDebugInterface1(
        0, IID_IDXGIDebug1, reinterpret_cast<void**>(debug.GetAddressOf()));
    if (SUCCEEDED(result)) {
      if (snapshot.phase == "baseline") {
        debug->EnableLeakTrackingForThread();
      }
      std::cout << "SDK leak_tracking_enabled="
                << (debug->IsLeakTrackingEnabledForThread() != FALSE)
                << std::endl;
      result = debug->ReportLiveObjects(
          DXGI_DEBUG_ALL,
          static_cast<DXGI_DEBUG_RLO_FLAGS>(DXGI_DEBUG_RLO_DETAIL |
                                            DXGI_DEBUG_RLO_SUMMARY));
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
                             std::chrono::steady_clock::now() - begin)
                             .count();
    std::cout << "RD_CAPTURE_REPORT end cycle=" << snapshot.cycle
              << " phase=" << snapshot.phase
              << " hresult=" << static_cast<std::uint32_t>(result)
              << " elapsed_ns="
              << snapshot.elapsed_ns + static_cast<std::uint64_t>(elapsed)
              << std::endl;
    return SUCCEEDED(result);
  }

}  // namespace rd::platform::win::test
