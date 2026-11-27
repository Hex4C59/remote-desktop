// Report SDK live objects outside capture calls.
// Thread: none
#pragma once

#include <cstdint>
#include <string_view>

namespace rd::platform::win::test {

  struct CaptureResourceSnapshot {
    std::uint32_t cycle;
    std::string_view phase;
    std::string_view mode;
    std::uint32_t attempt;
    std::uint64_t elapsed_ns;
    std::uint64_t frames_in_use;
    std::uint64_t submitted;
    std::uint64_t ready;
  };

  [[nodiscard]] bool report_capture_resources(
      const CaptureResourceSnapshot& snapshot) noexcept;

}  // namespace rd::platform::win::test
