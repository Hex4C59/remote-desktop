// Preallocated sampling and raw evidence for the 60 s and 600 s capture runs.
// Thread: none
#include "capture_measurement.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <iostream>
#include <memory>
#include <optional>
#include <span>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

#include "capture_memory_budget.h"
#include "desktop_fixture_win.h"
#include "remotedesktop/platform/win/screen_capture_win.h"

namespace rd::platform::win::test {
  namespace {
    using namespace std::chrono_literals;
    using Clock = std::chrono::steady_clock;
    constexpr std::size_t kWarmupFrames = 40;
    constexpr Point kCapturePoint{192, 112};
    constexpr std::array<std::uint32_t, 2> kTestColors{0x2250ac, 0xbe492a};
    constexpr double kAcquireBudgetMs = 6.0;

    std::uint64_t nanoseconds(Clock::duration duration) noexcept {
      return static_cast<std::uint64_t>(
          std::chrono::duration_cast<std::chrono::nanoseconds>(duration)
              .count());
    }

    struct Animation {
      void tick(DesktopWindow& window, Clock::time_point now) noexcept {
        if (now >= next_paint) {
          window.paint(kTestColors[paints++ % kTestColors.size()]);
          next_paint = now + 16ms;
        }
      }
      Clock::time_point next_paint;
      std::size_t paints{};
    };

    struct ReleaseFrame {
      void operator()(Frame* frame) const noexcept { frame->release(); }
    };
    using FrameLease = std::unique_ptr<Frame, ReleaseFrame>;

    struct CaptureCall {
      std::uint64_t started_ns{};
      std::uint64_t finished_ns{};
      CaptureReadbackStats readback;
      PlatformError error{PlatformError::kTimeout};
      bool delivered{};
      bool pixel_occluded{};
    };

    struct CaptureDelivery {
      std::uint64_t delivered_ns{};
      std::uint64_t capture_timestamp_ns{};
      double age_ms{};
      std::uint32_t rgb{};
    };

    struct SampleDetails {
      std::uint64_t monotonic_ns{};
      CaptureReadbackStats readback;
      std::optional<WindowBounds> window;
      bool pixel_occluded{};
    };

    struct DurationSummary {
      double min_ms{};
      double p95_ms{};
      double max_ms{};
      std::size_t above_budget{};
    };

    DurationSummary summarize(std::span<double> values, double budget_ms) {
      if (values.empty()) {
        return {};
      }
      const auto above_budget = std::ranges::count_if(
          values, [budget_ms](double ms) { return ms > budget_ms; });
      std::ranges::sort(values);
      return {values.front(), values[(95 * values.size() + 99) / 100 - 1],
              values.back(), static_cast<std::size_t>(above_budget)};
    }

    double call_ms(const CaptureCall& call) noexcept {
      return static_cast<double>(call.finished_ns - call.started_ns) /
             1'000'000.0;
    }

    void report_change(std::uint64_t current, std::uint64_t baseline) {
      if (current < baseline) {
        std::cout << '-' << baseline - current;
      } else {
        std::cout << current - baseline;
      }
    }

    void report_readback(const CaptureReadbackStats& current,
                         const CaptureReadbackStats& baseline = {}) {
      std::cout << " readback_submitted="
                << current.submitted - baseline.submitted
                << " readback_ready=" << current.ready - baseline.ready
                << " readback_discarded="
                << current.discarded - baseline.discarded
                << " query_busy=" << current.query_busy - baseline.query_busy
                << " map_busy=" << current.map_busy - baseline.map_busy;
    }

    void report_window(const std::optional<WindowBounds>& bounds,
                       bool pixel_occluded) {
      std::cout << " window_bounds_available=" << bounds.has_value();
      if (bounds) {
        std::cout << " window_rect=" << bounds->top_left.x << ','
                  << bounds->top_left.y << ',' << bounds->bottom_right.x << ','
                  << bounds->bottom_right.y
                  << " primary_visible=" << bounds->primary_visible;
      }
      std::cout << " pixel_occluded=" << pixel_occluded;
    }
  }  // namespace

  void run_capture_measurement(ScreenCaptureWin& capture, DesktopWindow& window,
                               const CaptureMeasurementConfig& config,
                               void (*pump_desktop)(void*) noexcept,
                               void* desktop_context) {
    ASSERT_GT(config.duration.count(), 0);
    ASSERT_GT(config.memory_sample_interval.count(), 0);
    ASSERT_EQ(config.duration % config.memory_sample_interval, 0s);
    ASSERT_GT(config.max_fps, 0U);
    ASSERT_NE(pump_desktop, nullptr);
    const auto tag = config.enforce_acquire_budget ? "PWH-01" : "PWH-07";
    const auto placed = window.place_on_primary(kCapturePoint);
    const auto pixel = window.screen_point(kCapturePoint);
    const auto bounds = window.bounds();
    const auto initially_occluded = !pixel || !window.owns_screen_point(*pixel);
    std::cout << tag << " PID=" << process_id();
    report_window(bounds, initially_occluded);
    std::cout << std::endl;
    ASSERT_TRUE(placed);
    ASSERT_TRUE(bounds.has_value());
    ASSERT_TRUE(bounds->primary_visible);
    ASSERT_FALSE(initially_occluded);
    ASSERT_TRUE(window.stays_passive_on_click());

    const auto display_result = capture.display_info();
    const auto* display = std::get_if<DisplayInfo>(&display_result);
    ASSERT_NE(display, nullptr);
    EXPECT_EQ(display->dpi, window.dpi());
    ASSERT_TRUE(pixel.has_value());
    ASSERT_GE(pixel->x, 0);
    ASSERT_GE(pixel->y, 0);
    ASSERT_LT(static_cast<std::uint32_t>(pixel->x), display->width);
    ASSERT_LT(static_cast<std::uint32_t>(pixel->y), display->height);

    const auto next_frame = [&](Frame* frame) {
      PlatformResult<FrameDesc> result = PlatformError::kTimeout;
      const auto deadline = Clock::now() + 4s;
      Animation animation{Clock::now()};
      do {
        pump_desktop(desktop_context);
        window.pump();
        animation.tick(window, Clock::now());
        result = capture.acquire_frame(frame, 0ms);
        const auto* error = std::get_if<PlatformError>(&result);
        if (error == nullptr || *error != PlatformError::kTimeout) {
          break;
        }
        std::this_thread::sleep_for(5ms);
      } while (Clock::now() < deadline);
      return result;
    };
    const auto probe = next_frame(nullptr);
    const auto* probe_desc = std::get_if<FrameDesc>(&probe);
    ASSERT_NE(probe_desc, nullptr);
    FramePool pool{
        1, static_cast<std::size_t>(probe_desc->stride) * probe_desc->height};

    const CaptureMemoryBudget budget{nanoseconds(config.duration),
                                     nanoseconds(config.memory_sample_interval),
                                     config.final_growth_bytes,
                                     config.sampled_growth_bytes};
    const auto intervals = static_cast<std::size_t>(
        config.duration / config.memory_sample_interval);
    const auto sample_count = intervals + 1;
    // One call per loop, followed by a 1 ms sleep: these capacities also
    // include the call/frame that can finish just after the cutoff. Value
    // initialization touches the storage before warmup; no record grows during
    // measurement.
    const auto duration_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(config.duration);
    const auto max_calls = static_cast<std::size_t>(duration_ms.count()) + 1;
    const auto max_frames =
        static_cast<std::size_t>(config.duration.count()) * config.max_fps + 1;
    std::vector<CaptureMemorySample> memory(sample_count);
    std::vector<SampleDetails> sample_details(sample_count);
    std::vector<CaptureCall> calls(max_calls);
    std::vector<CaptureDelivery> deliveries(max_frames);
    std::vector<double> timing_scratch(max_calls);
    std::vector<double> age_scratch(max_frames);
    std::size_t call_count = 0;
    std::size_t frames = 0;
    std::size_t timeouts = 0;
    std::size_t pattern_matches = 0;
    std::size_t occluded_mismatches = 0;
    std::size_t occluded_calls = 0;
    std::size_t slow_deliveries = 0;
    std::optional<std::uint32_t> first_mismatch;
    std::uint64_t last_timestamp = 0;
    std::cout << tag << " capture=" << display->width << 'x' << display->height
              << " dpi=" << display->dpi << " pitch=" << probe_desc->stride
              << " configured_fps=" << config.max_fps
              << " acquire_timeout_ms=0 duration_s=" << config.duration.count()
              << " memory_sample_interval_s="
              << config.memory_sample_interval.count()
              << " final_budget_bytes=" << budget.final_growth_bytes
              << " sampled_budget_bytes=" << budget.sampled_growth_bytes
              << " enforce_6_ms=" << config.enforce_acquire_budget << std::endl;

    for (std::size_t count = 0; count < kWarmupFrames; ++count) {
      const FrameLease frame{pool.try_acquire_free()};
      ASSERT_NE(frame, nullptr);
      ASSERT_TRUE(std::holds_alternative<FrameDesc>(next_frame(frame.get())));
    }
    // This is the sole baseline, immediately after the original 40-frame
    // warmup.
    const auto initial_memory = private_bytes();
    const auto begin = Clock::now();
    ASSERT_TRUE(initial_memory.has_value());
    memory.front() = {0, *initial_memory};
    const auto sample_context = [&] {
      return SampleDetails{nanoseconds(Clock::now().time_since_epoch()),
                           capture.readback_stats(), window.bounds(),
                           !window.owns_screen_point(*pixel)};
    };
    sample_details.front() = sample_context();
    sample_details.front().monotonic_ns = nanoseconds(begin.time_since_epoch());
    const auto before_readback = sample_details.front().readback;
    const auto end = begin + config.duration;
    auto next_sample = begin + config.memory_sample_interval;
    std::size_t memory_index = 1;
    Animation animation{begin};
    while (Clock::now() < end) {
      window.pump();
      pump_desktop(desktop_context);
      animation.tick(window, Clock::now());
      {
        const FrameLease frame{pool.try_acquire_free()};
        ASSERT_NE(frame.get(), nullptr);
        const auto pixel_occluded = !window.owns_screen_point(*pixel);
        const auto started = Clock::now();
        const auto result = capture.acquire_frame(frame.get(), 0ms);
        const auto finished = Clock::now();
        ASSERT_LT(call_count, calls.size());
        auto& call = calls[call_count++];
        call.started_ns = nanoseconds(started - begin);
        call.finished_ns = nanoseconds(finished - begin);
        call.readback = capture.readback_stats();
        call.pixel_occluded = pixel_occluded;
        occluded_calls += pixel_occluded;
        if (const auto* desc = std::get_if<FrameDesc>(&result)) {
          call.delivered = true;
          ASSERT_LT(frames, deliveries.size());
          const auto delivered_ns = nanoseconds(finished.time_since_epoch());
          ASSERT_GE(delivered_ns, desc->capture_timestamp_ns);
          auto& delivery = deliveries[frames++];
          delivery.delivered_ns = delivered_ns;
          delivery.capture_timestamp_ns = desc->capture_timestamp_ns;
          delivery.age_ms =
              static_cast<double>(delivered_ns - desc->capture_timestamp_ns) /
              1'000'000.0;
          slow_deliveries += call_ms(call) > kAcquireBudgetMs;
          ASSERT_EQ(desc->display_map_version, config.display_map_version);
          ASSERT_GT(desc->capture_timestamp_ns, last_timestamp);
          if (last_timestamp != 0) {
            ASSERT_GE(desc->capture_timestamp_ns - last_timestamp, 33'333'334U);
          }
          last_timestamp = desc->capture_timestamp_ns;
          const auto i = static_cast<std::size_t>(pixel->y) * desc->stride +
                         static_cast<std::size_t>(pixel->x) * 4;
          const auto pixels = frame->pixels();
          ASSERT_LT(i + 2, pixels.size());
          delivery.rgb = (std::to_integer<std::uint32_t>(pixels[i + 2]) << 16) |
                         (std::to_integer<std::uint32_t>(pixels[i + 1]) << 8) |
                         std::to_integer<std::uint32_t>(pixels[i]);
          if (delivery.rgb == kTestColors[0] ||
              delivery.rgb == kTestColors[1]) {
            ++pattern_matches;
          } else {
            occluded_mismatches += !window.owns_screen_point(*pixel);
            if (!first_mismatch) {
              first_mismatch = delivery.rgb;
            }
          }
        } else {
          call.error = std::get<PlatformError>(result);
          ASSERT_EQ(call.error, PlatformError::kTimeout)
              << "Unexpected capture error=" << static_cast<int>(call.error);
          ++timeouts;
        }
      }
      const auto now = Clock::now();
      if (memory_index + 1 < memory.size() && now >= next_sample && now < end) {
        const auto sample = private_bytes();
        const auto sampled_at = Clock::now();
        ASSERT_TRUE(sample.has_value());
        memory[memory_index] = {nanoseconds(sampled_at - begin), *sample};
        sample_details[memory_index] = sample_context();
        sample_details[memory_index++].monotonic_ns =
            nanoseconds(sampled_at.time_since_epoch());
        // Never fabricate catch-up samples after a missed interval. The record
        // judge rejects the missing slot using the actual sample timestamps.
        next_sample =
            begin +
            config.memory_sample_interval *
                ((sampled_at - begin) / config.memory_sample_interval + 1);
      }
      std::this_thread::sleep_for(1ms);
    }
    // Read the final commit before sorting, reporting or releasing any owner.
    const auto final_memory = private_bytes();
    const auto finished = Clock::now();
    ASSERT_TRUE(final_memory.has_value());
    memory.back() = {nanoseconds(finished - begin), *final_memory};
    sample_details.back() = sample_context();
    sample_details.back().monotonic_ns =
        nanoseconds(finished.time_since_epoch());
    const auto after_readback = sample_details.back().readback;
    const auto seconds =
        std::chrono::duration<double>(finished - begin).count();
    const auto fps = static_cast<double>(frames) / seconds;
    const auto assessment = assess_capture_memory(memory, budget);

    std::cout << tag << " seconds=" << seconds << " frames=" << frames
              << " fps=" << fps << " calls=" << call_count
              << " timeouts=" << timeouts
              << " pattern_matches=" << pattern_matches
              << " occluded_calls=" << occluded_calls
              << " pool_in_use=" << pool.in_use()
              << " private_initial=" << *initial_memory
              << " private_final=" << *final_memory << " private_change=";
    report_change(*final_memory, *initial_memory);
    std::cout << " final_growth_bytes=" << assessment.final_growth_bytes
              << " sampled_growth_bytes=" << assessment.sampled_growth_bytes
              << " memory_verdict=" << static_cast<int>(assessment.verdict)
              << '\n';
    if (first_mismatch) {
      std::cout << tag << " pixel mismatch first_rgb=" << *first_mismatch
                << " occluded=" << occluded_mismatches << " pixel=" << pixel->x
                << ',' << pixel->y << '\n';
    }
    for (std::size_t i = 0; i < memory.size(); ++i) {
      std::cout << tag << " memory_sample=" << i
                << " monotonic_ns=" << sample_details[i].monotonic_ns
                << " elapsed_ns=" << memory[i].elapsed_ns
                << " private_bytes=" << memory[i].private_bytes
                << " baseline_change=";
      report_change(memory[i].private_bytes, memory.front().private_bytes);
      report_readback(sample_details[i].readback);
      report_window(sample_details[i].window, sample_details[i].pixel_occluded);
      std::cout << '\n';
      EXPECT_TRUE(sample_details[i].window.has_value());
      if (sample_details[i].window) {
        EXPECT_TRUE(sample_details[i].window->primary_visible);
      }
      EXPECT_FALSE(sample_details[i].pixel_occluded);
    }
    for (std::size_t i = 0; i < call_count; ++i) {
      const auto& call = calls[i];
      timing_scratch[i] = call_ms(call);
      std::cout << tag << " call=" << i << " started_ns=" << call.started_ns
                << " finished_ns=" << call.finished_ns
                << " elapsed_ms=" << timing_scratch[i]
                << " delivered=" << call.delivered;
      if (!call.delivered) {
        std::cout << " error=" << static_cast<int>(call.error);
      }
      std::cout << " pixel_occluded=" << call.pixel_occluded;
      report_readback(call.readback);
      std::cout << '\n';
    }
    for (std::size_t i = 0; i < frames; ++i) {
      const auto& delivery = deliveries[i];
      age_scratch[i] = delivery.age_ms;
      std::cout << tag << " frame=" << i
                << " delivered_monotonic_ns=" << delivery.delivered_ns
                << " capture_timestamp_ns=" << delivery.capture_timestamp_ns
                << " age_ms=" << delivery.age_ms << " rgb=" << delivery.rgb
                << '\n';
    }
    const auto latency = summarize(std::span{timing_scratch}.first(call_count),
                                   kAcquireBudgetMs);
    const auto age = summarize(std::span{age_scratch}.first(frames), 33.0);
    std::cout << (config.enforce_acquire_budget ? "PWH-06" : tag)
              << " calls=" << call_count << " delivered=" << frames
              << " min_ms=" << latency.min_ms << " p95_ms=" << latency.p95_ms
              << " max_ms=" << latency.max_ms
              << " above_6_ms=" << latency.above_budget
              << " slow_deliveries=" << slow_deliveries
              << " frame_age_min_ms=" << age.min_ms
              << " frame_age_p95_ms=" << age.p95_ms
              << " frame_age_max_ms=" << age.max_ms
              << " age_above_33_ms=" << age.above_budget;
    report_readback(after_readback, before_readback);
    std::cout << '\n';

    const auto minute_ns = nanoseconds(60s);
    const auto begin_ns = nanoseconds(begin.time_since_epoch());
    std::size_t previous_call = 0;
    std::size_t previous_frame = 0;
    std::size_t previous_sample = 0;
    const auto minutes = (config.duration.count() + 59) / 60;
    for (std::int64_t minute = 1; minute <= minutes; ++minute) {
      const auto boundary = std::min(
          static_cast<std::uint64_t>(minute) * minute_ns, budget.duration_ns);
      const bool last_minute = minute == minutes;
      std::size_t call_end = previous_call;
      while (call_end < call_count &&
             (last_minute || calls[call_end].finished_ns < boundary)) {
        timing_scratch[call_end - previous_call] = call_ms(calls[call_end]);
        ++call_end;
      }
      std::size_t frame_end = previous_frame;
      while (frame_end < frames &&
             (last_minute ||
              deliveries[frame_end].delivered_ns - begin_ns < boundary)) {
        age_scratch[frame_end - previous_frame] = deliveries[frame_end].age_ms;
        ++frame_end;
      }
      const auto sample_index = std::min(
          static_cast<std::size_t>(boundary / budget.sample_interval_ns),
          memory.size() - 1);
      const auto minute_latency =
          summarize(std::span{timing_scratch}.first(call_end - previous_call),
                    kAcquireBudgetMs);
      const auto minute_age = summarize(
          std::span{age_scratch}.first(frame_end - previous_frame), 33.0);
      const auto minute_begin =
          static_cast<std::uint64_t>(minute - 1) * minute_ns;
      const auto minute_seconds =
          static_cast<double>(boundary - minute_begin) / 1'000'000'000.0;
      std::cout << tag << " minute=" << minute
                << " sample_elapsed_ns=" << memory[sample_index].elapsed_ns
                << " private_bytes=" << memory[sample_index].private_bytes
                << " baseline_change=";
      report_change(memory[sample_index].private_bytes,
                    memory.front().private_bytes);
      std::cout << " minute_change=";
      report_change(memory[sample_index].private_bytes,
                    memory[previous_sample].private_bytes);
      std::cout << " calls=" << call_end - previous_call
                << " frames=" << frame_end - previous_frame << " timeouts="
                << (call_end - previous_call) - (frame_end - previous_frame)
                << " seconds=" << minute_seconds << " fps="
                << static_cast<double>(frame_end - previous_frame) /
                       minute_seconds
                << " min_ms=" << minute_latency.min_ms
                << " p95_ms=" << minute_latency.p95_ms
                << " max_ms=" << minute_latency.max_ms
                << " above_6_ms=" << minute_latency.above_budget
                << " frame_age_min_ms=" << minute_age.min_ms
                << " frame_age_p95_ms=" << minute_age.p95_ms
                << " frame_age_max_ms=" << minute_age.max_ms
                << " age_above_33_ms=" << minute_age.above_budget;
      report_readback(sample_details[sample_index].readback,
                      sample_details[previous_sample].readback);
      std::cout << '\n';
      previous_call = call_end;
      previous_frame = frame_end;
      previous_sample = sample_index;
    }

    EXPECT_EQ(pattern_matches, frames);
    EXPECT_GE(seconds, static_cast<double>(config.duration.count()));
    EXPECT_LE(fps, static_cast<double>(config.max_fps));
    EXPECT_EQ(pool.free_count(), 1U);
    EXPECT_EQ(occluded_calls, 0U);
    EXPECT_EQ(assessment.verdict, CaptureMemoryVerdict::kWithinBudget);
    EXPECT_LE(assessment.final_growth_bytes, budget.final_growth_bytes);
    EXPECT_LE(assessment.sampled_growth_bytes, budget.sampled_growth_bytes);
    ASSERT_GT(frames, 0U);
    if (config.enforce_acquire_budget) {
      EXPECT_LE(latency.max_ms, kAcquireBudgetMs);
    }
  }
}  // namespace rd::platform::win::test
