// Verify complete sampling, budget edges and fixed-batch memory decisions.
// Thread: none
#include "capture_memory_budget.h"

#include <gtest/gtest.h>

#include <array>
#include <cstdint>
#include <limits>
#include <span>

namespace rd::platform::win::test {
  namespace {

    constexpr std::uint64_t kSecondNs = 1'000'000'000;
    constexpr std::uint64_t kInitialBytes = 64 * 1024 * 1024;
    constexpr CaptureMemoryBudget kBudget{60 * kSecondNs, kSecondNs, 64 * 1024,
                                          256 * 1024};
    using Verdict = CaptureMemoryVerdict;

    std::array<CaptureMemorySample, 61> complete_samples() {
      std::array<CaptureMemorySample, 61> samples{};
      for (std::size_t i = 0; i < samples.size(); ++i) {
        samples[i] = {i * kSecondNs, kInitialBytes};
      }
      return samples;
    }

    TEST(CaptureMemoryBudget, AcceptsBothExactBoundaries) {
      auto samples = complete_samples();
      samples[15].private_bytes += kBudget.sampled_growth_bytes;
      samples.back().private_bytes += kBudget.final_growth_bytes;
      const auto result = assess_capture_memory(samples, kBudget);
      EXPECT_EQ(result.verdict, Verdict::kWithinBudget);
      EXPECT_EQ(result.final_growth_bytes, 65'536u);
      EXPECT_EQ(result.sampled_growth_bytes, 262'144u);
    }

    TEST(CaptureMemoryBudget, RejectsFinalGrowthOneByteOverBudget) {
      auto samples = complete_samples();
      samples.back().private_bytes += kBudget.final_growth_bytes + 1;
      const auto result = assess_capture_memory(samples, kBudget);
      EXPECT_EQ(result.verdict, Verdict::kFinalBudgetExceeded);
      EXPECT_EQ(result.final_growth_bytes, 65'537u);
    }

    TEST(CaptureMemoryBudget, RejectsSamplePeakEvenAfterRecovery) {
      auto samples = complete_samples();
      samples[30].private_bytes += kBudget.sampled_growth_bytes + 1;
      const auto result = assess_capture_memory(samples, kBudget);
      EXPECT_EQ(result.verdict, Verdict::kSampleBudgetExceeded);
      EXPECT_EQ(result.sampled_growth_bytes, 262'145u);
      EXPECT_EQ(result.final_growth_bytes, 0u);
    }

    TEST(CaptureMemoryBudget, AcceptsDecreaseWithoutUnsignedWrap) {
      auto samples = complete_samples();
      samples.back().private_bytes -= 64 * 1024;
      const auto result = assess_capture_memory(samples, kBudget);
      EXPECT_EQ(result.verdict, Verdict::kWithinBudget);
      EXPECT_EQ(result.final_growth_bytes, 0u);
      EXPECT_EQ(result.sampled_growth_bytes, 0u);
    }

    TEST(CaptureMemoryBudget, HandlesValuesNearUnsignedMaximum) {
      auto samples = complete_samples();
      for (auto& sample : samples) {
        sample.private_bytes = std::numeric_limits<std::uint64_t>::max() - 10;
      }
      samples.back().private_bytes += 9;
      EXPECT_EQ(assess_capture_memory(samples, kBudget).verdict,
                Verdict::kWithinBudget);
    }

    TEST(CaptureMemoryBudget, RejectsMissingFirstSample) {
      const auto samples = complete_samples();
      EXPECT_EQ(
          assess_capture_memory(std::span{samples}.subspan(1), kBudget).verdict,
          Verdict::kInvalidSamples);
    }

    TEST(CaptureMemoryBudget, RejectsMissingFinalSample) {
      const auto samples = complete_samples();
      EXPECT_EQ(
          assess_capture_memory(std::span{samples}.first(60), kBudget).verdict,
          Verdict::kInvalidSamples);
    }

    TEST(CaptureMemoryBudget, RejectsReversedSampleTime) {
      auto samples = complete_samples();
      samples[30].elapsed_ns = samples[29].elapsed_ns - 1;
      EXPECT_EQ(assess_capture_memory(samples, kBudget).verdict,
                Verdict::kInvalidSamples);
    }

    TEST(CaptureMemoryBudget, RejectsDuplicateSampleTime) {
      auto samples = complete_samples();
      samples[30].elapsed_ns = samples[29].elapsed_ns;
      EXPECT_EQ(assess_capture_memory(samples, kBudget).verdict,
                Verdict::kInvalidSamples);
    }

    TEST(CaptureMemoryBudget, RejectsIncompleteMeasurementPeriod) {
      auto samples = complete_samples();
      samples.back().elapsed_ns = kBudget.duration_ns - 1;
      EXPECT_EQ(assess_capture_memory(samples, kBudget).verdict,
                Verdict::kInvalidSamples);
    }

    TEST(CaptureMemoryBudget, RejectsSampleOutsideItsScheduledInterval) {
      auto samples = complete_samples();
      samples[30].elapsed_ns = samples[31].elapsed_ns + 1;
      samples[31].elapsed_ns = samples[30].elapsed_ns + 1;
      EXPECT_EQ(assess_capture_memory(samples, kBudget).verdict,
                Verdict::kInvalidSamples);
    }

    TEST(CaptureMemoryBudget, RequiresEveryFixedRunToPass) {
      const std::array runs{
          CaptureMemoryAssessment{Verdict::kWithinBudget},
          CaptureMemoryAssessment{Verdict::kFinalBudgetExceeded},
          CaptureMemoryAssessment{Verdict::kWithinBudget}};
      EXPECT_FALSE(all_capture_runs_within_budget(runs));
    }

    TEST(CaptureMemoryBudget, AcceptsCompletePassingBatch) {
      const std::array runs{CaptureMemoryAssessment{Verdict::kWithinBudget},
                            CaptureMemoryAssessment{Verdict::kWithinBudget},
                            CaptureMemoryAssessment{Verdict::kWithinBudget}};
      EXPECT_TRUE(all_capture_runs_within_budget(runs));
      EXPECT_FALSE(all_capture_runs_within_budget({}));
    }

  }  // namespace
}  // namespace rd::platform::win::test
