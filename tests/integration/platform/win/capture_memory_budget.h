// Judge fixed capture-memory records without querying Windows or allocating.
// Thread: none
#pragma once

#include <cstdint>
#include <span>

namespace rd::platform::win::test {

  struct CaptureMemorySample {
    std::uint64_t elapsed_ns;
    std::uint64_t private_bytes;
  };

  struct CaptureMemoryBudget {
    std::uint64_t duration_ns;
    std::uint64_t sample_interval_ns;
    std::uint64_t final_growth_bytes;
    std::uint64_t sampled_growth_bytes;
  };

  enum class CaptureMemoryVerdict {
    kWithinBudget,
    kInvalidSamples,
    kFinalBudgetExceeded,
    kSampleBudgetExceeded,
  };

  struct CaptureMemoryAssessment {
    CaptureMemoryVerdict verdict{CaptureMemoryVerdict::kInvalidSamples};
    std::uint64_t final_growth_bytes{};
    std::uint64_t sampled_growth_bytes{};
  };

  [[nodiscard]] CaptureMemoryAssessment assess_capture_memory(
      std::span<const CaptureMemorySample> samples,
      const CaptureMemoryBudget& budget) noexcept;

  [[nodiscard]] bool all_capture_runs_within_budget(
      std::span<const CaptureMemoryAssessment> runs) noexcept;

}  // namespace rd::platform::win::test
