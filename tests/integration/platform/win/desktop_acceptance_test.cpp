// PWH-01–06 on the interactive Windows desktop with a dedicated test window.
// Thread: none
#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <iostream>
#include <memory>
#include <span>
#include <string_view>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

#include "desktop_fixture_win.h"
#include "remotedesktop/platform/win/desktop_event_source_win.h"
#include "remotedesktop/platform/win/input_inject_win.h"
#include "remotedesktop/platform/win/screen_capture_win.h"

namespace rd::platform::win::test {
  namespace {
    using namespace std::chrono_literals;
    using Clock = std::chrono::steady_clock;
    constexpr std::uint32_t kStartVersion = 5;
    constexpr std::uint32_t kMaxFps = 30;
    constexpr Point kClientPoint{64, 64};
    constexpr Point kCapturePoint{192, 112};
    constexpr std::array<std::uint32_t, 2> kTestColors{0x2250ac, 0xbe492a};

    constexpr auto kRunDuration = 60s;
    constexpr auto kMemorySampleInterval = 15s;
    constexpr auto kWarmupFrames = 40;

    struct WindowAnimation {
      void tick(DesktopWindow& window, Clock::time_point now) noexcept {
        if (now >= next_paint) {
          window.paint(kTestColors[paints++ % kTestColors.size()]);
          next_paint = now + 16ms;
        }
      }

      Clock::time_point next_paint;
      std::size_t paints{};
    };

    bool ok(const PlatformResult<void>& result) noexcept {
      return std::holds_alternative<std::monostate>(result);
    }

    template <typename T>
    bool has_error(const std::variant<T, PlatformError>& result,
                   PlatformError error) noexcept {
      const auto* actual = std::get_if<PlatformError>(&result);
      return actual != nullptr && *actual == error;
    }

    const char* state_name(DesktopState state) noexcept {
      switch (state) {
        case DesktopState::kInteractive:
          return "Interactive";
        case DesktopState::kLocked:
          return "Locked";
        case DesktopState::kSecureDesktop:
          return "SecureDesktop";
        case DesktopState::kLoggedOut:
          return "LoggedOut";
        case DesktopState::kUnknown:
          return "Unknown";
      }
      return "invalid";
    }

    class DesktopBinding {
     public:
      bool subscribe(LocalSessionGeneration generation) {
        latest_ = {generation, 0, DesktopState::kUnknown};
        auto result = observer_.subscribe(generation, record, this);
        if (const auto* initial = std::get_if<DesktopObservation>(&result)) {
          record(this, *initial);
          return latest_.state == DesktopState::kInteractive;
        }
        std::cout << "desktop subscription error="
                  << static_cast<int>(std::get<PlatformError>(result)) << '\n';
        return false;
      }

      void close() noexcept { observer_.unsubscribe(latest_.generation); }
      void pump() noexcept { source_.pump_notifications(); }
      DesktopState state() const noexcept { return latest_.state; }

      DesktopStateReader reader() const noexcept {
        return {[](const void* context) noexcept {
                  return static_cast<const DesktopBinding*>(context)->state();
                },
                this};
      }

     private:
      static void record(void* context,
                         DesktopObservation observation) noexcept {
        auto& latest = static_cast<DesktopBinding*>(context)->latest_;
        if (observation.generation == latest.generation &&
            observation.sequence > latest.sequence) {
          latest = observation;
          std::cout << "desktop generation=" << latest.generation
                    << " sequence=" << latest.sequence
                    << " state=" << state_name(latest.state) << std::endl;
        }
      }

      DesktopEventSourceWin source_;
      SessionStateWin observer_{source_};
      DesktopObservation latest_{0, 0, DesktopState::kUnknown};
    };

    struct ReleaseFrame {
      void operator()(Frame* frame) const noexcept { frame->release(); }
    };
    using FrameLease = std::unique_ptr<Frame, ReleaseFrame>;

    struct TestInput {
      explicit TestInput(DesktopStateReader desktop) : injector(desktop) {}
      ~TestInput() { EXPECT_TRUE(ok(injector.release_all_pressed())); }
      InputInjectorWin injector;
    };

    enum class MemoryLoad {
      kPaint,
      kDisplayQueries,
      kInitialized,
      kProbe,
      kPixels
    };

    class DesktopAcceptance : public ::testing::Test {
     protected:
      void SetUp() override {
        ASSERT_TRUE(desktop_.subscribe(1))
            << "Log in to the Windows console and unlock the desktop.";
      }

      template <typename Predicate>
      bool wait_for(DesktopWindow& window, Clock::duration budget,
                    Predicate predicate) {
        const auto deadline = Clock::now() + budget;
        do {
          desktop_.pump();
          window.pump();
          if (predicate()) {
            return true;
          }
          std::this_thread::sleep_for(5ms);
        } while (Clock::now() < deadline);
        return false;
      }

      bool focus(DesktopWindow& window) {
        window.activate();
        if (!window.focused()) {
          std::cout
              << "Click the title bar of the Remote Desktop PWH test window."
              << std::endl;
        }
        if (!wait_for(window, 45s, [&] {
              return window.focused() && !left_button_down();
            })) {
          return false;
        }
        window.clear_input();
        return true;
      }

      bool start(ScreenCaptureWin& capture, std::uint32_t version) {
        const auto result = capture.initialize(
            {.max_fps = kMaxFps, .initial_display_map_version = version});
        if (!ok(result)) {
          std::cout << "capture initialize error="
                    << static_cast<int>(std::get<PlatformError>(result))
                    << '\n';
        }
        return ok(result);
      }

      PlatformResult<FrameDesc> next_frame(ScreenCaptureWin& capture,
                                           Frame* frame,
                                           DesktopWindow& window) {
        PlatformResult<FrameDesc> result = PlatformError::kTimeout;
        auto next_paint = Clock::now();
        std::size_t color = 0;
        static_cast<void>(wait_for(window, 4s, [&] {
          const auto now = Clock::now();
          if (now >= next_paint) {
            window.paint(kTestColors[color++ % kTestColors.size()]);
            next_paint = now + 16ms;
          }
          result = capture.acquire_frame(frame, 0ms);
          return !has_error(result, PlatformError::kTimeout);
        }));
        return result;
      }

      bool verify_pixels(ScreenCaptureWin& capture, DesktopWindow& window,
                         std::uint32_t version, const DisplayMode& mode) {
        const auto probe = next_frame(capture, nullptr, window);
        const auto* probe_desc = std::get_if<FrameDesc>(&probe);
        if (probe_desc == nullptr) {
          std::cout << "probe error="
                    << static_cast<int>(std::get<PlatformError>(probe)) << '\n';
          return false;
        }
        FramePool pool{1, static_cast<std::size_t>(probe_desc->stride) *
                              probe_desc->height};
        const FrameLease frame{pool.try_acquire_free()};
        const auto captured = next_frame(capture, frame.get(), window);
        const auto* desc = std::get_if<FrameDesc>(&captured);
        if (desc == nullptr) {
          std::cout << "pixel acquisition error="
                    << static_cast<int>(std::get<PlatformError>(captured))
                    << '\n';
          return false;
        }
        std::cout << "pixel frame " << desc->width << 'x' << desc->height
                  << " stride=" << desc->stride
                  << " version=" << desc->display_map_version
                  << " timestamp_ns=" << desc->capture_timestamp_ns << '\n';
        return desc->width == mode.width && desc->height == mode.height &&
               desc->display_map_version == version &&
               desc->capture_timestamp_ns > 0 &&
               frame->pixels().size() ==
                   static_cast<std::size_t>(desc->stride) * desc->height;
      }

      bool inject_into(DesktopWindow& window, InputInjectorWin& injector,
                       InputEvent event) {
        if (!window.focused()) {
          return false;
        }
        return ok(injector.inject(event)) && event.inject_timestamp_ns > 0;
      }

      void measure_memory(MemoryLoad load);

      DesktopBinding desktop_;
    };

    void DesktopAcceptance::measure_memory(MemoryLoad load) {
      const auto capture_pixels = load == MemoryLoad::kPixels;
      const auto capture_frames = capture_pixels || load == MemoryLoad::kProbe;
      const auto query_display = load == MemoryLoad::kInitialized ||
                                 load == MemoryLoad::kDisplayQueries;
      std::cout << "Memory control PID=" << process_id() << std::endl;
      const auto before_setup = memory_footprint();
      ASSERT_TRUE(before_setup.has_value());
      std::optional<DesktopWindow> window{std::in_place,
                                          L"Remote Desktop PWH-01 / PWH-06"};
      ASSERT_TRUE(window->ready());
      std::optional<ScreenCaptureWin> capture;
      std::optional<FramePool> pool;
      if (capture_frames || load == MemoryLoad::kInitialized) {
        capture.emplace(desktop_.reader());
        ASSERT_TRUE(start(*capture, kStartVersion));
        const auto probe = next_frame(*capture, nullptr, *window);
        const auto* desc = std::get_if<FrameDesc>(&probe);
        ASSERT_NE(desc, nullptr);
        pool.emplace(1, static_cast<std::size_t>(desc->stride) * desc->height);
        for (int count = 0; count < kWarmupFrames; ++count) {
          const FrameLease frame{capture_pixels ? pool->try_acquire_free()
                                                : nullptr};
          ASSERT_TRUE(std::holds_alternative<FrameDesc>(
              next_frame(*capture, frame.get(), *window)));
        }
      } else {
        WindowAnimation warmup{Clock::now()};
        ASSERT_TRUE(wait_for(*window, 4s, [&] {
          warmup.tick(*window, Clock::now());
          return warmup.paints == kWarmupFrames;
        }));
      }
      std::array<MemoryFootprint, 5> samples{};
      const auto warm = memory_footprint();
      ASSERT_TRUE(warm.has_value());
      samples[0] = *warm;
      std::size_t sample_index = 1;
      std::size_t calls = 0;
      std::size_t frames = 0;
      const auto begin = Clock::now();
      WindowAnimation animation{begin};
      while (Clock::now() < begin + kRunDuration) {
        window->pump();
        desktop_.pump();
        const auto now = Clock::now();
        animation.tick(*window, now);
        if (capture_frames) {
          const FrameLease frame{capture_pixels ? pool->try_acquire_free()
                                                : nullptr};
          const auto result = capture->acquire_frame(frame.get(), 0ms);
          ASSERT_TRUE(has_error(result, PlatformError::kTimeout) ||
                      std::holds_alternative<FrameDesc>(result));
          ++calls;
          frames += std::holds_alternative<FrameDesc>(result);
        }
        if (query_display) {
          ASSERT_TRUE(current_display_mode().has_value());
          ASSERT_NE(primary_monitor_dpi(), 0U);
          ++calls;
        }
        if (sample_index < samples.size() - 1 &&
            now - begin >= kMemorySampleInterval * sample_index) {
          const auto sample = memory_footprint();
          ASSERT_TRUE(sample.has_value());
          samples[sample_index++] = *sample;
        }
        std::this_thread::sleep_for(1ms);
      }
      const auto final = memory_footprint();
      ASSERT_TRUE(final.has_value());
      samples.back() = *final;
      std::cout << "Memory control paints=" << animation.paints
                << " calls=" << calls << " frames=" << frames
                << " pool_in_use=" << (pool ? pool->in_use() : 0) << '\n';
      if (pool) {
        EXPECT_EQ(pool->free_count(), 1U);
      }
      capture.reset();
      const auto without_capture = memory_footprint();
      ASSERT_TRUE(without_capture.has_value());
      pool.reset();
      const auto without_pool = memory_footprint();
      ASSERT_TRUE(without_pool.has_value());
      window.reset();
      desktop_.close();
      const auto after_teardown = memory_footprint();
      ASSERT_TRUE(after_teardown.has_value());

      const auto report = [](std::string_view stage,
                             const MemoryFootprint& footprint) {
        std::cout << "Memory stage=" << stage
                  << " private_commit=" << footprint.private_commit
                  << " heap_allocated=" << footprint.heap_allocated
                  << " heap_committed=" << footprint.heap_committed
                  << " heaps_sampled=" << footprint.heaps_sampled << '/'
                  << footprint.heap_count << " gdi=" << footprint.gdi_objects
                  << " user=" << footprint.user_objects << '\n';
        const auto heaps =
            std::span{footprint.heaps}.first(footprint.heaps_sampled);
        for (const auto& heap : heaps) {
          std::cout << "Heap stage=" << stage << " id=" << heap.id
                    << " process_heap=" << heap.process_heap
                    << " allocated=" << heap.allocated
                    << " committed=" << heap.committed << '\n';
        }
      };
      report("before_setup", *before_setup);
      constexpr std::array<std::string_view, 5> stages{"warm", "15s", "30s",
                                                       "45s", "60s"};
      for (std::size_t i = 0; i < stages.size(); ++i) {
        report(stages[i], samples[i]);
      }
      report("capture_released", *without_capture);
      report("pool_released", *without_pool);
      report("window_released", *after_teardown);
    }

    TEST(MemoryDiagnostics, ReportsProcessHeapAndConsistentTotals) {
      const auto footprint = memory_footprint();
      ASSERT_TRUE(footprint.has_value());
      ASSERT_GT(footprint->heaps_sampled, 0U);
      ASSERT_LE(footprint->heaps_sampled, footprint->heaps.size());
      ASSERT_LE(footprint->heaps_sampled, footprint->heap_count);
      const auto heaps =
          std::span{footprint->heaps}.first(footprint->heaps_sampled);
      EXPECT_EQ(std::ranges::count(heaps, true, &HeapFootprint::process_heap),
                1);
      std::uint64_t allocated = 0;
      std::uint64_t committed = 0;
      for (const auto& heap : heaps) {
        EXPECT_NE(heap.id, 0U);
        EXPECT_GE(heap.committed, heap.allocated);
        allocated += heap.allocated;
        committed += heap.committed;
      }
      EXPECT_EQ(allocated, footprint->heap_allocated);
      EXPECT_EQ(committed, footprint->heap_committed);
    }

    TEST_F(DesktopAcceptance, MemoryControlPaint) {
      measure_memory(MemoryLoad::kPaint);
    }
    TEST_F(DesktopAcceptance, MemoryControlDisplayQueries) {
      measure_memory(MemoryLoad::kDisplayQueries);
    }
    TEST_F(DesktopAcceptance, MemoryControlInitialized) {
      measure_memory(MemoryLoad::kInitialized);
    }
    TEST_F(DesktopAcceptance, MemoryControlProbe) {
      measure_memory(MemoryLoad::kProbe);
    }
    TEST_F(DesktopAcceptance, MemoryControlPixels) {
      measure_memory(MemoryLoad::kPixels);
    }

    struct DurationSummary {
      double min_ms{};
      double p95_ms{};
      double max_ms{};
      std::size_t above_budget{};
    };

    DurationSummary summarize(std::span<double> values, double budget_ms) {
      const auto above_budget = std::ranges::count_if(
          values, [budget_ms](double ms) { return ms > budget_ms; });
      std::ranges::sort(values);
      return {values.front(), values[(95 * values.size() + 99) / 100 - 1],
              values.back(), static_cast<std::size_t>(above_budget)};
    }

    TEST_F(DesktopAcceptance, Pwh01CaptureWindowStaysPassive) {
      {
        DesktopWindow capture{L"Remote Desktop capture window"};
        ASSERT_TRUE(capture.ready());
        EXPECT_TRUE(capture.stays_passive_on_click());
      }
      DesktopWindow input{L"Remote Desktop input window", WindowUse::kInput};
      ASSERT_TRUE(input.ready());
      EXPECT_FALSE(input.stays_passive_on_click());
    }

    TEST_F(DesktopAcceptance, Pwh01And06ContinuousCaptureAndAcquireTime) {
      DesktopWindow window{L"Remote Desktop PWH-01 / PWH-06"};
      ASSERT_TRUE(window.ready());
      ScreenCaptureWin capture{desktop_.reader()};
      ASSERT_TRUE(start(capture, kStartVersion));
      const auto display_result = capture.display_info();
      const auto* display = std::get_if<DisplayInfo>(&display_result);
      ASSERT_NE(display, nullptr);
      EXPECT_EQ(display->dpi, window.dpi());
      const auto probe = next_frame(capture, nullptr, window);
      const auto* probe_desc = std::get_if<FrameDesc>(&probe);
      ASSERT_NE(probe_desc, nullptr);
      FramePool pool{
          1, static_cast<std::size_t>(probe_desc->stride) * probe_desc->height};
      for (int count = 0; count < kWarmupFrames; ++count) {
        const FrameLease frame{pool.try_acquire_free()};
        ASSERT_TRUE(std::holds_alternative<FrameDesc>(
            next_frame(capture, frame.get(), window)));
      }
      const auto pixel = window.screen_point(kCapturePoint);
      ASSERT_TRUE(pixel.has_value());
      ASSERT_GE(pixel->x, 0);
      ASSERT_GE(pixel->y, 0);
      ASSERT_LT(static_cast<std::uint32_t>(pixel->x), display->width);
      ASSERT_LT(static_cast<std::uint32_t>(pixel->y), display->height);
      std::array<std::uint64_t, 5> memory{};
      std::vector<double> timings(60'001);
      std::array<double, 60 * kMaxFps + 1> ages{};
      std::size_t calls = 0;
      std::size_t slow_deliveries = 0;
      std::cout << "capture " << display->width << 'x' << display->height
                << " dpi=" << display->dpi << " pitch=" << probe_desc->stride
                << " configured_fps=" << kMaxFps
                << " acquire_timeout_ms=0 duration_s=60" << std::endl;
      const auto initial_memory = private_bytes();
      ASSERT_TRUE(initial_memory.has_value());
      memory[0] = *initial_memory;
      std::size_t memory_index = 1;
      std::size_t frames = 0;
      std::size_t timeouts = 0;
      std::size_t pattern_matches = 0;
      std::size_t occluded_mismatches = 0;
      std::optional<std::uint32_t> first_mismatch;
      std::uint64_t last_timestamp = 0;
      const auto before_readback = capture.readback_stats();
      const auto begin = Clock::now();
      const auto end = begin + kRunDuration;
      WindowAnimation animation{begin};
      while (Clock::now() < end) {
        window.pump();
        desktop_.pump();
        const auto now = Clock::now();
        animation.tick(window, now);
        {
          const FrameLease frame{pool.try_acquire_free()};
          ASSERT_NE(frame.get(), nullptr);
          const auto started = Clock::now();
          const auto result = capture.acquire_frame(frame.get(), 0ms);
          const auto finished = Clock::now();
          const auto elapsed_ms =
              std::chrono::duration<double, std::milli>(finished - started)
                  .count();
          ASSERT_LT(calls, timings.size());
          timings[calls++] = elapsed_ms;
          if (const auto* desc = std::get_if<FrameDesc>(&result)) {
            ASSERT_LT(frames, ages.size());
            const auto delivered_ns =
                std::chrono::duration_cast<std::chrono::nanoseconds>(
                    finished.time_since_epoch())
                    .count();
            ASSERT_GE(static_cast<std::uint64_t>(delivered_ns),
                      desc->capture_timestamp_ns);
            ages[frames++] =
                static_cast<double>(static_cast<std::uint64_t>(delivered_ns) -
                                    desc->capture_timestamp_ns) /
                1'000'000.0;
            slow_deliveries += elapsed_ms > 6.0;
            ASSERT_EQ(desc->display_map_version, kStartVersion);
            ASSERT_GT(desc->capture_timestamp_ns, last_timestamp);
            if (last_timestamp != 0) {
              ASSERT_GE(desc->capture_timestamp_ns - last_timestamp,
                        33'333'334U);
            }
            last_timestamp = desc->capture_timestamp_ns;
            const auto i = static_cast<std::size_t>(pixel->y) * desc->stride +
                           static_cast<std::size_t>(pixel->x) * 4;
            const auto pixels = frame->pixels();
            ASSERT_LT(i + 2, pixels.size());
            const auto rgb =
                (std::to_integer<std::uint32_t>(pixels[i + 2]) << 16) |
                (std::to_integer<std::uint32_t>(pixels[i + 1]) << 8) |
                std::to_integer<std::uint32_t>(pixels[i]);
            if (rgb == kTestColors[0] || rgb == kTestColors[1]) {
              ++pattern_matches;
            } else {
              occluded_mismatches += !window.owns_screen_point(*pixel);
              if (!first_mismatch) {
                first_mismatch = rgb;
              }
            }
          } else {
            const auto error = std::get<PlatformError>(result);
            ASSERT_EQ(error, PlatformError::kTimeout)
                << "Unexpected capture error=" << static_cast<int>(error);
            ++timeouts;
          }
        }
        if (memory_index < memory.size() - 1 &&
            now - begin >= kMemorySampleInterval * memory_index) {
          const auto sample = private_bytes();
          ASSERT_TRUE(sample.has_value());
          memory[memory_index++] = *sample;
        }
        std::this_thread::sleep_for(1ms);
      }
      const auto seconds =
          std::chrono::duration<double>(Clock::now() - begin).count();
      const auto final_memory = private_bytes();
      ASSERT_TRUE(final_memory.has_value());
      memory.back() = *final_memory;
      const auto fps = static_cast<double>(frames) / seconds;
      std::cout << "PWH-01 seconds=" << seconds << " frames=" << frames
                << " fps=" << fps << " timeouts=" << timeouts
                << " pattern_matches=" << pattern_matches
                << " pool_in_use=" << pool.in_use() << " private_bytes=";
      for (const auto bytes : memory) {
        std::cout << ' ' << bytes;
      }
      std::cout << '\n';
      if (first_mismatch) {
        std::cout << "PWH-01 pixel mismatch first_rgb=" << *first_mismatch
                  << " occluded=" << occluded_mismatches
                  << " pixel=" << pixel->x << ',' << pixel->y << '\n';
      }
      EXPECT_EQ(pattern_matches, frames);
      EXPECT_GE(seconds, 60.0);
      EXPECT_LE(fps, static_cast<double>(kMaxFps));
      EXPECT_EQ(pool.free_count(), 1U);
      EXPECT_LE(*final_memory, *initial_memory);
      ASSERT_GT(frames, 0U);

      const auto latency = summarize(std::span{timings}.first(calls), 6.0);
      const auto age = summarize(std::span{ages}.first(frames), 33.0);
      std::cout << "PWH-06 calls=" << calls << " delivered=" << frames
                << " min_ms=" << latency.min_ms << " p95_ms=" << latency.p95_ms
                << " max_ms=" << latency.max_ms
                << " above_6_ms=" << latency.above_budget
                << " slow_deliveries=" << slow_deliveries << '\n';
      std::cout << "PWH-06 frame_age_min_ms=" << age.min_ms
                << " frame_age_p95_ms=" << age.p95_ms
                << " frame_age_max_ms=" << age.max_ms
                << " age_above_33_ms=" << age.above_budget << '\n';
      const auto after_readback = capture.readback_stats();
      std::cout << "PWH-06 readback_submitted="
                << after_readback.submitted - before_readback.submitted
                << " readback_ready="
                << after_readback.ready - before_readback.ready
                << " readback_discarded="
                << after_readback.discarded - before_readback.discarded
                << " query_busy="
                << after_readback.query_busy - before_readback.query_busy
                << " map_busy="
                << after_readback.map_busy - before_readback.map_busy << '\n';
      EXPECT_LE(latency.max_ms, 6.0);
    }

    TEST_F(DesktopAcceptance, Pwh02ResolutionChange) {
      const auto original = current_display_mode();
      ASSERT_TRUE(original.has_value());
      DesktopWindow window{L"Remote Desktop PWH-02"};
      ASSERT_TRUE(window.ready());
      auto capture = std::make_unique<ScreenCaptureWin>(desktop_.reader());
      ASSERT_TRUE(start(*capture, kStartVersion));
      ASSERT_TRUE(verify_pixels(*capture, window, kStartVersion, *original));
      TemporaryDisplayMode temporary_mode;
      ASSERT_TRUE(temporary_mode.change_to_smaller_mode())
          << "display change status=" << temporary_mode.change_status();
      const auto changed = current_display_mode();
      ASSERT_TRUE(changed.has_value());
      ASSERT_NE(*changed, *original);
      std::cout << "PWH-02 original=" << original->width << 'x'
                << original->height << '@' << original->refresh_hz
                << " temporary=" << changed->width << 'x' << changed->height
                << '@' << changed->refresh_hz << '\n';
      const auto mapped = next_frame(*capture, nullptr, window);
      if (const auto* error = std::get_if<PlatformError>(&mapped)) {
        std::cout << "PWH-02 first result error=" << static_cast<int>(*error)
                  << '\n';
      } else {
        const auto& desc = std::get<FrameDesc>(mapped);
        std::cout << "PWH-02 first result frame=" << desc.width << 'x'
                  << desc.height << '\n';
      }
      EXPECT_TRUE(has_error(mapped, PlatformError::kDisplayChanged));
      bool recovered = false;
      if (has_error(mapped, PlatformError::kDisplayChanged)) {
        const auto display = capture->display_info();
        ASSERT_TRUE(std::holds_alternative<DisplayInfo>(display));
        EXPECT_EQ(std::get<DisplayInfo>(display).display_map_version,
                  kStartVersion + 1);
        for (int attempt = 0; attempt < 3 && !recovered; ++attempt) {
          const auto reacquired = next_frame(*capture, nullptr, window);
          if (has_error(reacquired, PlatformError::kAccessLost)) {
            std::cout << "PWH-02 duplication lost after mapping change. "
                         "Rebuilding.\n";
            break;
          }
          if (std::holds_alternative<FrameDesc>(reacquired)) {
            recovered =
                verify_pixels(*capture, window, kStartVersion + 1, *changed);
            break;
          }
          EXPECT_TRUE(has_error(reacquired, PlatformError::kDisplayChanged));
        }
      }
      capture.reset();
      if (!recovered) {
        ScreenCaptureWin rebuilt{desktop_.reader()};
        recovered =
            wait_for(window, 5s,
                     [&] { return start(rebuilt, kStartVersion + 1); }) &&
            verify_pixels(rebuilt, window, kStartVersion + 1, *changed);
        std::cout << "PWH-02 reconstructed=" << recovered << '\n';
      }
      EXPECT_TRUE(recovered);
      ASSERT_TRUE(temporary_mode.restore());
      ASSERT_TRUE(wait_for(window, 5s,
                           [&] { return current_display_mode() == original; }));
      std::cout << "PWH-02 original mode restored" << '\n';
    }

    TEST_F(DesktopAcceptance, Pwh03LockAndUnlock) {
      const auto mode = current_display_mode();
      ASSERT_TRUE(mode.has_value());
      DesktopWindow window{L"PWH-03 - Press Win+L, then unlock Windows"};
      ASSERT_TRUE(window.ready());
      auto capture = std::make_unique<ScreenCaptureWin>(desktop_.reader());
      ASSERT_TRUE(start(*capture, kStartVersion));
      ASSERT_TRUE(verify_pixels(*capture, window, kStartVersion, *mode));
      ScreenCaptureWin unbound;
      EXPECT_TRUE(has_error(unbound.initialize({}),
                            PlatformError::kSessionNotInteractive));
      std::cout << "PWH-03 READY: lock Windows with Win+L, then unlock it "
                   "normally. Waiting up to 150 seconds."
                << std::endl;
      const auto locked = wait_for(window, 150s, [&] {
        return desktop_.state() == DesktopState::kLocked ||
               desktop_.state() == DesktopState::kSecureDesktop;
      });
      ASSERT_TRUE(locked) << "A lock transition through the native desktop "
                             "observer is required.";
      const auto while_locked = capture->acquire_frame(nullptr, 0ms);
      EXPECT_TRUE(has_error(while_locked, PlatformError::kSecureDesktop));
      if (const auto* error = std::get_if<PlatformError>(&while_locked)) {
        std::cout << "PWH-03 capture while locked error="
                  << static_cast<int>(*error) << std::endl;
      }
      ASSERT_TRUE(wait_for(window, 60s, [&] {
        return desktop_.state() == DesktopState::kInteractive;
      }));
      capture.reset();
      ScreenCaptureWin rebuilt{desktop_.reader()};
      ASSERT_TRUE(wait_for(window, 5s,
                           [&] { return start(rebuilt, kStartVersion + 1); }));
      EXPECT_TRUE(verify_pixels(rebuilt, window, kStartVersion + 1, *mode));
    }

    TEST_F(DesktopAcceptance, Pwh04ClickAndTextReachTestWindow) {
      DesktopWindow window{L"Remote Desktop PWH-04 - click and text",
                           WindowUse::kInput};
      ASSERT_TRUE(window.ready());
      ASSERT_TRUE(focus(window));
      ASSERT_FALSE(left_button_down());
      const auto point = window.screen_point(kClientPoint);
      ASSERT_TRUE(point.has_value());
      TestInput session{desktop_.reader()};
      auto& injector = session.injector;
      ASSERT_TRUE(inject_into(window, injector,
                              {.x = point->x, .y = point->y, .text = {}}));
      const auto at_target =
          wait_for(window, 250ms, [&] { return physical_cursor() == point; });
      const auto cursor = physical_cursor();
      if (cursor) {
        const auto bounds = virtual_desktop_size();
        std::cout << "PWH-04 pointer target=" << point->x << ',' << point->y
                  << " landed=" << cursor->x << ',' << cursor->y
                  << " virtual_size=" << bounds.x << 'x' << bounds.y << '\n';
      }
      ASSERT_TRUE(at_target);
      ASSERT_TRUE(inject_into(window, injector,
                              {.kind = InputKind::kButtonDown, .text = {}}));
      ASSERT_TRUE(inject_into(window, injector,
                              {.kind = InputKind::kButtonUp, .text = {}}));
      constexpr std::string_view kText = "Rd 003!";
      ASSERT_TRUE(inject_into(window, injector,
                              {.kind = InputKind::kText, .text = kText}));
      ASSERT_TRUE(wait_for(window, 2s, [&] {
        return window.input().mouse_ups > 0 &&
               window.input().text.size() >= kText.size();
      }));
      const auto& input = window.input();
      EXPECT_EQ(input.mouse_downs, 1U);
      EXPECT_EQ(input.mouse_ups, 1U);
      EXPECT_EQ(input.mouse_down_at, kClientPoint);
      EXPECT_EQ(input.mouse_up_at, kClientPoint);
      EXPECT_TRUE(input.text == kText);
      EXPECT_EQ(injector.pressed_count(), 0U);
      std::cout << "PWH-04 desktop target=" << point->x << ',' << point->y
                << " client click=" << input.mouse_down_at.x << ','
                << input.mouse_down_at.y << " dpi=" << window.dpi()
                << " text_matches=" << (input.text == kText)
                << " ascii_char_count=" << input.text.size() << '\n';
    }

    TEST_F(DesktopAcceptance,
           Pwh05LocalCloseReleasesHeldInputAndAllowsNewGeneration) {
      DesktopWindow window{L"Remote Desktop PWH-05 - local close",
                           WindowUse::kInput};
      ASSERT_TRUE(window.ready());
      ASSERT_TRUE(focus(window));
      ASSERT_FALSE(f8_down());
      ASSERT_FALSE(left_button_down());
      const auto point = window.screen_point(kClientPoint);
      ASSERT_TRUE(point.has_value());
      {
        TestInput session{desktop_.reader()};
        auto& injector = session.injector;
        ASSERT_TRUE(inject_into(window, injector,
                                {.x = point->x, .y = point->y, .text = {}}));
        ASSERT_TRUE(wait_for(window, 250ms,
                             [&] { return physical_cursor() == point; }));
        ASSERT_TRUE(inject_into(window, injector,
                                {.kind = InputKind::kButtonDown, .text = {}}));
        ASSERT_TRUE(inject_into(
            window, injector,
            {.kind = InputKind::kKeyDown, .key = Key::kF8, .text = {}}));
        ASSERT_TRUE(wait_for(window, 2s, [&] {
          return window.input().key_downs == 1 &&
                 window.input().mouse_downs == 1;
        }));
        ASSERT_TRUE(f8_down());
        ASSERT_TRUE(left_button_down());
        ASSERT_EQ(injector.pressed_count(), 2U);
        ASSERT_TRUE(window.post_close());
        ASSERT_TRUE(wait_for(window, 2s,
                             [&] { return window.input().close_requested; }));
        ASSERT_TRUE(ok(injector.release_all_pressed()));
        EXPECT_EQ(injector.pressed_count(), 0U);
        ASSERT_TRUE(wait_for(window, 2s, [&] {
          return window.input().key_ups == 1 && window.input().mouse_ups == 1;
        }));
        EXPECT_FALSE(f8_down());
        EXPECT_FALSE(left_button_down());
        std::cout << "PWH-05 local close: presses_before=2 presses_after="
                  << injector.pressed_count()
                  << " key_ups=" << window.input().key_ups
                  << " mouse_ups=" << window.input().mouse_ups << '\n';
      }
      desktop_.close();
      ASSERT_TRUE(desktop_.subscribe(2));
      window.clear_input();
      TestInput restarted{desktop_.reader()};
      ASSERT_TRUE(inject_into(window, restarted.injector,
                              {.kind = InputKind::kText, .text = "OK"}));
      ASSERT_TRUE(
          wait_for(window, 2s, [&] { return window.input().text == "OK"; }));
      std::cout << "PWH-05 new generation delivered 2 ASCII characters" << '\n';
    }
  }  // namespace
}  // namespace rd::platform::win::test

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  if (!rd::platform::win::test::use_physical_pixel_coordinates()) {
    std::cerr
        << "Windows per-monitor DPI mode is required for desktop acceptance.\n";
    return 1;
  }
  return RUN_ALL_TESTS();
}
