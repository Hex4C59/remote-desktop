// Judge fixed capture-memory records without querying Windows or allocating.
// Thread: none
#include "capture_memory_budget.h"

namespace rd::platform::win::test {

  CaptureMemoryAssessment assess_capture_memory(
      std::span<const CaptureMemorySample> samples,
      const CaptureMemoryBudget& budget) noexcept {
    CaptureMemoryAssessment result{};
    if (samples.size() < 2 || budget.duration_ns == 0 ||
        budget.sample_interval_ns == 0 || samples.front().elapsed_ns != 0 ||
        samples.back().elapsed_ns < budget.duration_ns) {
      return result;
    }
    const auto intervals =
        budget.duration_ns / budget.sample_interval_ns +
        (budget.duration_ns % budget.sample_interval_ns != 0);
    if (intervals != samples.size() - 1) {
      return result;
    }
    for (std::size_t i = 1; i < samples.size(); ++i) {
      if (samples[i].elapsed_ns <= samples[i - 1].elapsed_ns) {
        return result;
      }
      if (i + 1 < samples.size()) {
        const auto slot = i * budget.sample_interval_ns;
        const auto end = budget.duration_ns - slot < budget.sample_interval_ns
                             ? budget.duration_ns
                             : slot + budget.sample_interval_ns;
        if (samples[i].elapsed_ns < slot || samples[i].elapsed_ns >= end) {
          return result;
        }
      }
    }
    const auto initial = samples.front().private_bytes;
    for (const auto& sample : samples) {
      const auto growth =
          sample.private_bytes > initial ? sample.private_bytes - initial : 0;
      if (growth > result.sampled_growth_bytes) {
        result.sampled_growth_bytes = growth;
      }
    }
    result.final_growth_bytes = samples.back().private_bytes > initial
                                    ? samples.back().private_bytes - initial
                                    : 0;
    if (result.final_growth_bytes > budget.final_growth_bytes) {
      result.verdict = CaptureMemoryVerdict::kFinalBudgetExceeded;
    } else if (result.sampled_growth_bytes > budget.sampled_growth_bytes) {
      result.verdict = CaptureMemoryVerdict::kSampleBudgetExceeded;
    } else {
      result.verdict = CaptureMemoryVerdict::kWithinBudget;
    }
    return result;
  }

  bool all_capture_runs_within_budget(
      std::span<const CaptureMemoryAssessment> runs) noexcept {
    if (runs.empty()) {
      return false;
    }
    for (const auto& run : runs) {
      if (run.verdict != CaptureMemoryVerdict::kWithinBudget) {
        return false;
      }
    }
    return true;
  }

}  // namespace rd::platform::win::test
