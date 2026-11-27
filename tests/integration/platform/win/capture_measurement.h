// Fixed-duration capture measurements for interactive desktop acceptance only.
// Thread: none
#pragma once

#include <chrono>
#include <cstdint>

namespace rd::platform::win {
  class ScreenCaptureWin;

  namespace test {
    class DesktopWindow;

    struct CaptureMeasurementConfig {
      std::chrono::seconds duration;
      std::chrono::seconds memory_sample_interval;
      std::uint64_t final_growth_bytes;
      std::uint64_t sampled_growth_bytes;
      std::uint32_t max_fps;
      std::uint32_t display_map_version;
      bool enforce_acquire_budget;
    };

    // The caller keeps the initialized capture, window and desktop binding
    // alive until the final sample and all raw records have been reported.
    void run_capture_measurement(ScreenCaptureWin& capture,
                                 DesktopWindow& window,
                                 const CaptureMeasurementConfig& config,
                                 void (*pump_desktop)(void*) noexcept,
                                 void* desktop_context);
  }  // namespace test
}  // namespace rd::platform::win
