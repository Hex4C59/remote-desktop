// Scripted coverage for Windows desktop capture and readback.
// Thread: none
#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <limits>
#include <memory>
#include <thread>

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include "remotedesktop/platform/win/screen_capture_win.h"

namespace rd::platform::win {
  namespace {
    using namespace std::chrono_literals;
    using ::testing::_;
    using ::testing::ElementsAreArray;
    using ::testing::InSequence;
    using ::testing::Return;
    using ::testing::VariantWith;

    class MockCaptureBackend : public CaptureBackend {
     public:
      MOCK_METHOD(PlatformResult<CaptureLayout>, initialize,
                  (const CaptureConfig&), (noexcept, override));
      MOCK_METHOD(PlatformResult<CaptureSample>, acquire, (std::uint32_t),
                  (noexcept, override));
      MOCK_METHOD(PlatformResult<void>, submit_readback, (),
                  (noexcept, override));
      MOCK_METHOD(PlatformResult<void>, poll_readback, (),
                  (noexcept, override));
      MOCK_METHOD(PlatformResult<MappedCapture>, map_pixels, (),
                  (noexcept, override));
      MOCK_METHOD(void, unmap_pixels, (), (noexcept, override));
      MOCK_METHOD(PlatformResult<void>, release_frame, (),
                  (noexcept, override));

      std::optional<CaptureLayout> observed_display_change(
          const DisplayInfo&) noexcept override {
        return observed_change;
      }
      std::uint64_t now_ns() const noexcept override { return clock_ns; }

      std::optional<CaptureLayout> observed_change;
      std::uint64_t clock_ns{};
    };

    class ScreenCaptureTest : public ::testing::Test {
     protected:
      static constexpr CaptureLayout kLayout{2, 2, 8, 120};
      static constexpr std::uint64_t kTimestamp = 1'000'000'000;

      void initialize(std::uint32_t version = 5,
                      CaptureLayout layout = kLayout) {
        EXPECT_CALL(backend_, initialize(_))
            .WillOnce(Return(PlatformResult<CaptureLayout>{layout}));
        EXPECT_THAT(
            capture_.initialize({.initial_display_map_version = version}),
            VariantWith<std::monostate>(std::monostate{}));
      }

      void acquire(CaptureLayout layout, std::uint64_t timestamp = kTimestamp) {
        EXPECT_CALL(backend_, acquire(10))
            .WillOnce([this, layout, timestamp](std::uint32_t) {
              backend_.clock_ns = timestamp;
              return PlatformResult<CaptureSample>{
                  CaptureSample{layout, timestamp}};
            });
      }

      void submit(PlatformResult<void> result = std::monostate{}) {
        EXPECT_CALL(backend_, submit_readback()).WillOnce(Return(result));
      }

      void poll(PlatformResult<void> result = std::monostate{}) {
        EXPECT_CALL(backend_, poll_readback()).WillOnce(Return(result));
      }

      void expect_submitted_frame(std::uint64_t timestamp = kTimestamp) {
        acquire(kLayout, timestamp);
        submit();
        release();
      }

      static void seed_frame(Frame& frame) {
        *frame.mutable_desc() = {.capture_timestamp_ns = 11,
                                 .display_map_version = 42};
        std::ranges::fill(frame.mutable_pixels(), std::byte{0x6a});
      }

      static void expect_seeded_frame(Frame& frame) {
        EXPECT_EQ(frame.desc().width, 0U);
        EXPECT_EQ(frame.desc().height, 0U);
        EXPECT_EQ(frame.desc().stride, 0U);
        EXPECT_EQ(frame.desc().capture_timestamp_ns, 11U);
        EXPECT_EQ(frame.desc().display_map_version, 42U);
        EXPECT_TRUE(std::ranges::all_of(
            frame.mutable_pixels(),
            [](std::byte pixel) { return pixel == std::byte{0x6a}; }));
      }

      void release() {
        EXPECT_CALL(backend_, release_frame())
            .WillOnce(Return(PlatformResult<void>{std::monostate{}}));
      }

      void map(std::span<const std::byte> pixels, std::uint32_t stride) {
        EXPECT_CALL(backend_, map_pixels())
            .WillOnce(Return(
                PlatformResult<MappedCapture>{MappedCapture{pixels, stride}}));
        EXPECT_CALL(backend_, unmap_pixels());
      }

      static auto borrow_frame(FramePool& pool) {
        return std::unique_ptr<Frame, decltype([](Frame* frame) {
                                 frame->release();
                               })>{pool.try_acquire_free()};
      }

      DesktopState desktop_{DesktopState::kInteractive};
      ::testing::StrictMock<MockCaptureBackend> backend_;
      ScreenCaptureWin capture_{
          backend_,
          {[](const void* state) noexcept {
             return *static_cast<const DesktopState*>(state);
           },
           &desktop_}};
    };

    TEST_F(ScreenCaptureTest, Pw01AcquireBeforeInitializeIsUnavailable) {
      EXPECT_THAT(capture_.acquire_frame(nullptr, 10ms),
                  VariantWith<PlatformError>(PlatformError::kUnavailable));
      EXPECT_THAT(capture_.display_info(),
                  VariantWith<PlatformError>(PlatformError::kUnavailable));
    }

    TEST_F(ScreenCaptureTest, Pw02RepeatedInitializeIsAProgrammingError) {
      initialize();
#ifndef NDEBUG
      EXPECT_DEATH(static_cast<void>(capture_.initialize({})),
                   "already initialized");
#else
      EXPECT_THAT(
          capture_.initialize({}),
          VariantWith<PlatformError>(PlatformError::kAlreadyInitialized));
#endif
    }

    TEST_F(ScreenCaptureTest, Pw03TimeoutIsBoundedAndPollingContinues) {
      initialize();
      const InSequence sequence;
      EXPECT_CALL(backend_, acquire(10)).WillOnce([](std::uint32_t timeout_ms) {
        std::this_thread::sleep_for(std::chrono::milliseconds{timeout_ms});
        return PlatformResult<CaptureSample>{PlatformError::kTimeout};
      });
      const auto start = std::chrono::steady_clock::now();
      EXPECT_THAT(capture_.acquire_frame(nullptr, 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      const auto elapsed = std::chrono::steady_clock::now() - start;
      EXPECT_GE(elapsed, 10ms);
      EXPECT_LE(elapsed, 100ms);

      acquire(kLayout);
      release();
      EXPECT_TRUE(std::holds_alternative<FrameDesc>(
          capture_.acquire_frame(nullptr, 10ms)));
    }

    TEST_F(ScreenCaptureTest, Pw04CopiesPixelsAndWritesFrameDescription) {
      initialize();
      const InSequence sequence;
      std::array<std::byte, 16> pixels{};
      for (std::size_t i = 0; i < pixels.size(); ++i) {
        pixels[i] = static_cast<std::byte>(i);
      }
      expect_submitted_frame();
      poll();
      map(pixels, 8);

      FramePool pool{1, pixels.size()};
      auto frame = borrow_frame(pool);
      const auto result = capture_.acquire_frame(frame.get(), 10ms);
      const auto* desc = std::get_if<FrameDesc>(&result);
      ASSERT_NE(desc, nullptr);
      EXPECT_EQ(desc->width, 2U);
      EXPECT_EQ(desc->height, 2U);
      EXPECT_EQ(desc->stride, 8U);
      EXPECT_EQ(desc->format, PixelFormat::kBGRA8);
      EXPECT_EQ(desc->capture_timestamp_ns, kTimestamp);
      EXPECT_EQ(desc->display_map_version, 5U);
      EXPECT_EQ(frame->desc().capture_timestamp_ns, kTimestamp);
      EXPECT_EQ(frame->desc().display_map_version, 5U);
      EXPECT_THAT(frame->pixels(), ElementsAreArray(pixels));
      EXPECT_EQ(pool.in_use(), 1U);
      frame.reset();
      EXPECT_EQ(pool.in_use(), 0U);
    }

    TEST_F(ScreenCaptureTest, Pw04ProbeReturnsLayoutWithoutMappingPixels) {
      initialize();
      const InSequence sequence;
      acquire({2, 2, 16, 120});
      release();
      const auto result = capture_.acquire_frame(nullptr, 10ms);
      const auto* desc = std::get_if<FrameDesc>(&result);
      ASSERT_NE(desc, nullptr);
      EXPECT_EQ(desc->width, 2U);
      EXPECT_EQ(desc->height, 2U);
      EXPECT_EQ(desc->stride, 16U);
      EXPECT_EQ(desc->display_map_version, 5U);
    }

    TEST_F(ScreenCaptureTest, Pw05AccessLostRequiresNewCaptureInstance) {
      initialize();
      EXPECT_CALL(backend_, acquire(10))
          .WillOnce(Return(
              PlatformResult<CaptureSample>{PlatformError::kAccessLost}));
      EXPECT_THAT(capture_.acquire_frame(nullptr, 10ms),
                  VariantWith<PlatformError>(PlatformError::kAccessLost));
      EXPECT_THAT(capture_.acquire_frame(nullptr, 10ms),
                  VariantWith<PlatformError>(PlatformError::kAccessLost));
    }

    TEST_F(ScreenCaptureTest, Pw05AccessLostDuringReleaseOverridesSample) {
      initialize();
      const InSequence sequence;
      acquire(kLayout);
      EXPECT_CALL(backend_, release_frame())
          .WillOnce(Return(PlatformResult<void>{PlatformError::kAccessLost}));
      EXPECT_THAT(capture_.acquire_frame(nullptr, 10ms),
                  VariantWith<PlatformError>(PlatformError::kAccessLost));
      EXPECT_THAT(capture_.acquire_frame(nullptr, 10ms),
                  VariantWith<PlatformError>(PlatformError::kAccessLost));
    }

    TEST_F(ScreenCaptureTest,
           Pw06ReportsObservedChangeBeforeAcquiringFromOldMode) {
      initialize();
      backend_.observed_change = CaptureLayout{3, 1, 12, 120};
      EXPECT_CALL(backend_, acquire(10))
          .WillOnce(Return(
              PlatformResult<CaptureSample>{PlatformError::kAccessLost}));
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      *frame->mutable_desc() = {.display_map_version = 42};
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kDisplayChanged));
      EXPECT_EQ(frame->desc().display_map_version, 42U);
      const auto display = capture_.display_info();
      ASSERT_TRUE(std::holds_alternative<DisplayInfo>(display));
      EXPECT_EQ(std::get<DisplayInfo>(display).width, 3U);
      EXPECT_EQ(std::get<DisplayInfo>(display).display_map_version, 6U);

      backend_.observed_change.reset();
      EXPECT_THAT(capture_.acquire_frame(nullptr, 10ms),
                  VariantWith<PlatformError>(PlatformError::kAccessLost));
    }

    TEST_F(ScreenCaptureTest, Pw06ChangesAdvanceVersionBeforeTheNextFrame) {
      initialize();
      const InSequence sequence;
      constexpr CaptureLayout resized{3, 1, 12, 120};
      acquire(resized);
      release();
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      *frame->mutable_desc() = {.display_map_version = 42};
      auto buffer = frame->mutable_pixels();
      std::ranges::fill(buffer, std::byte{0x6a});
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kDisplayChanged));
      EXPECT_EQ(frame->desc().display_map_version, 42U);
      EXPECT_TRUE(std::ranges::all_of(
          buffer, [](std::byte b) { return b == std::byte{0x6a}; }));
      auto display = capture_.display_info();
      ASSERT_TRUE(std::holds_alternative<DisplayInfo>(display));
      EXPECT_EQ(std::get<DisplayInfo>(display).width, 3U);
      EXPECT_EQ(std::get<DisplayInfo>(display).height, 1U);
      EXPECT_EQ(std::get<DisplayInfo>(display).display_map_version, 6U);

      constexpr CaptureLayout dpi_changed{3, 1, 12, 144};
      acquire(dpi_changed);
      release();
      EXPECT_THAT(capture_.acquire_frame(nullptr, 10ms),
                  VariantWith<PlatformError>(PlatformError::kDisplayChanged));
      display = capture_.display_info();
      ASSERT_TRUE(std::holds_alternative<DisplayInfo>(display));
      EXPECT_EQ(std::get<DisplayInfo>(display).display_map_version, 7U);
      EXPECT_EQ(std::get<DisplayInfo>(display).dpi, 144U);
      EXPECT_FLOAT_EQ(std::get<DisplayInfo>(display).scale, 144.0F / 96.0F);

      acquire(dpi_changed);
      release();
      const auto frame_result = capture_.acquire_frame(nullptr, 10ms);
      ASSERT_TRUE(std::holds_alternative<FrameDesc>(frame_result));
      EXPECT_EQ(std::get<FrameDesc>(frame_result).display_map_version, 7U);
    }

    TEST_F(ScreenCaptureTest, Pw07DisplayInfoIsPureAndScaleMatchesDpi) {
      initialize();
      const auto first = capture_.display_info();
      const auto second = capture_.display_info();
      ASSERT_TRUE(std::holds_alternative<DisplayInfo>(first));
      ASSERT_TRUE(std::holds_alternative<DisplayInfo>(second));
      EXPECT_EQ(std::get<DisplayInfo>(first).display_map_version,
                std::get<DisplayInfo>(second).display_map_version);
      EXPECT_EQ(std::get<DisplayInfo>(second).dpi, 120U);
      EXPECT_FLOAT_EQ(std::get<DisplayInfo>(second).scale, 120.0F / 96.0F);
    }

    TEST_F(ScreenCaptureTest, Pw08RebuiltCaptureKeepsSessionStartVersion) {
      initialize();
      ::testing::StrictMock<MockCaptureBackend> rebuilt_backend;
      const auto interactive = [](const void*) noexcept {
        return DesktopState::kInteractive;
      };
      ScreenCaptureWin rebuilt{rebuilt_backend, {interactive, nullptr}};
      EXPECT_CALL(rebuilt_backend, initialize(_))
          .WillOnce(Return(PlatformResult<CaptureLayout>{kLayout}));
      EXPECT_THAT(rebuilt.initialize({.initial_display_map_version = 7}),
                  VariantWith<std::monostate>(std::monostate{}));
      for (int read = 0; read < 2; ++read) {
        const auto current = rebuilt.display_info();
        ASSERT_TRUE(std::holds_alternative<DisplayInfo>(current));
        EXPECT_EQ(std::get<DisplayInfo>(current).display_map_version, 7U);
      }
    }

    TEST_F(ScreenCaptureTest, Pw20CopiesPaddedRowsUsingMappedStride) {
      initialize();
      const InSequence sequence;
      constexpr std::array<std::byte, 24> source{
          std::byte{1},    std::byte{2},    std::byte{3},    std::byte{4},
          std::byte{5},    std::byte{6},    std::byte{7},    std::byte{8},
          std::byte{0xff}, std::byte{0xff}, std::byte{0xff}, std::byte{0xff},
          std::byte{9},    std::byte{10},   std::byte{11},   std::byte{12},
          std::byte{13},   std::byte{14},   std::byte{15},   std::byte{16},
          std::byte{0xff}, std::byte{0xff}, std::byte{0xff}, std::byte{0xff}};
      constexpr std::array<std::byte, 24> expected{
          std::byte{1},  std::byte{2},  std::byte{3},  std::byte{4},
          std::byte{5},  std::byte{6},  std::byte{7},  std::byte{8},
          std::byte{},   std::byte{},   std::byte{},   std::byte{},
          std::byte{9},  std::byte{10}, std::byte{11}, std::byte{12},
          std::byte{13}, std::byte{14}, std::byte{15}, std::byte{16},
          std::byte{},   std::byte{},   std::byte{},   std::byte{}};
      expect_submitted_frame();
      poll();
      map(source, 12);
      FramePool pool{1, expected.size()};
      auto frame = borrow_frame(pool);
      const auto result = capture_.acquire_frame(frame.get(), 10ms);
      ASSERT_TRUE(std::holds_alternative<FrameDesc>(result));
      EXPECT_EQ(std::get<FrameDesc>(result).stride, 12U);
      EXPECT_THAT(frame->pixels(), ElementsAreArray(expected));
    }

    TEST_F(ScreenCaptureTest,
           Pw20RejectsSmallDestinationAndStillUnmapsAndReleases) {
      initialize();
      const InSequence sequence;
      constexpr std::array<std::byte, 24> source{};
      expect_submitted_frame();
      poll();
      map(source, 12);
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kInvalidArgument));
      EXPECT_EQ(frame->desc().stride, 0U);
    }

    TEST_F(ScreenCaptureTest, ReleasesAcquiredFrameWhenMappingFails) {
      initialize();
      const InSequence sequence;
      expect_submitted_frame();
      poll();
      EXPECT_CALL(backend_, map_pixels())
          .WillOnce(Return(
              PlatformResult<MappedCapture>{PlatformError::kUnavailable}));
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kUnavailable));
    }

    TEST_F(ScreenCaptureTest, LockedAndSecureDesktopStopCapture) {
      initialize();
      for (const auto state :
           {DesktopState::kLocked, DesktopState::kSecureDesktop}) {
        desktop_ = state;
        EXPECT_THAT(capture_.acquire_frame(nullptr, 10ms),
                    VariantWith<PlatformError>(PlatformError::kSecureDesktop));
      }
      desktop_ = DesktopState::kUnknown;
      EXPECT_THAT(
          capture_.acquire_frame(nullptr, 10ms),
          VariantWith<PlatformError>(PlatformError::kSessionNotInteractive));
    }

    TEST_F(ScreenCaptureTest, PacesOutputWithoutKeepingAcquiredFrames) {
      initialize();
      const InSequence sequence;
      acquire(kLayout, kTimestamp);
      release();
      acquire(kLayout, kTimestamp + 33'333'333);
      release();
      acquire(kLayout, kTimestamp + 33'333'334);
      release();
      EXPECT_TRUE(std::holds_alternative<FrameDesc>(
          capture_.acquire_frame(nullptr, 10ms)));
      EXPECT_THAT(capture_.acquire_frame(nullptr, 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      EXPECT_TRUE(std::holds_alternative<FrameDesc>(
          capture_.acquire_frame(nullptr, 10ms)));
    }

    TEST_F(ScreenCaptureTest,
           EarlyZeroWaitPollDoesNotAcquireUntilFrameIntervalElapses) {
      initialize();
      const InSequence sequence;
      constexpr std::uint64_t kFrameInterval = 33'333'334;
      acquire(kLayout);
      release();
      ASSERT_TRUE(std::holds_alternative<FrameDesc>(
          capture_.acquire_frame(nullptr, 10ms)));

      backend_.clock_ns = kTimestamp + kFrameInterval - 1;
      EXPECT_CALL(backend_, acquire(0)).Times(0);
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      seed_frame(*frame);
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 0ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      expect_seeded_frame(*frame);
      ASSERT_TRUE(::testing::Mock::VerifyAndClearExpectations(&backend_));

      // A mapping change must still be observable during the frame interval.
      backend_.observed_change = CaptureLayout{2, 2, 8, 144};
      EXPECT_THAT(capture_.acquire_frame(frame.get(), -1ms),
                  VariantWith<PlatformError>(PlatformError::kDisplayChanged));
      expect_seeded_frame(*frame);
      backend_.observed_change.reset();
      backend_.clock_ns = kTimestamp + kFrameInterval;
      EXPECT_CALL(backend_, acquire(0))
          .WillOnce(Return(PlatformResult<CaptureSample>{
              CaptureSample{CaptureLayout{2, 2, 8, 144}, backend_.clock_ns}}));
      release();
      const auto result = capture_.acquire_frame(nullptr, 0ms);
      ASSERT_TRUE(std::holds_alternative<FrameDesc>(result));
      EXPECT_EQ(std::get<FrameDesc>(result).capture_timestamp_ns,
                kTimestamp + kFrameInterval);
      EXPECT_EQ(std::get<FrameDesc>(result).display_map_version, 6U);
    }

    TEST_F(ScreenCaptureTest,
           Pw22BusyReadbackUsesOnlyTheFrameFromTheCurrentCall) {
      initialize();
      const InSequence sequence;
      const std::array pixels{
          std::byte{1},  std::byte{2},  std::byte{3},  std::byte{4},
          std::byte{5},  std::byte{6},  std::byte{7},  std::byte{8},
          std::byte{9},  std::byte{10}, std::byte{11}, std::byte{12},
          std::byte{13}, std::byte{14}, std::byte{15}, std::byte{16}};
      expect_submitted_frame();
      poll(PlatformError::kTimeout);
      poll();
      EXPECT_CALL(backend_, map_pixels())
          .WillOnce(
              Return(PlatformResult<MappedCapture>{PlatformError::kTimeout}));
      map(pixels, 8);

      FramePool first_pool{1, pixels.size()};
      FramePool next_pool{1, pixels.size()};
      auto first = borrow_frame(first_pool);
      auto next = borrow_frame(next_pool);
      seed_frame(*first);
      seed_frame(*next);
      EXPECT_THAT(capture_.acquire_frame(first.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      expect_seeded_frame(*first);
      first.reset();
      EXPECT_EQ(first_pool.free_count(), 1U);

      backend_.clock_ns = kTimestamp + 2'000'000;
      EXPECT_THAT(capture_.acquire_frame(next.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      expect_seeded_frame(*next);
      backend_.clock_ns = kTimestamp + 4'000'000;
      const auto result = capture_.acquire_frame(next.get(), 10ms);
      const auto* desc = std::get_if<FrameDesc>(&result);
      ASSERT_NE(desc, nullptr);
      EXPECT_EQ(desc->capture_timestamp_ns, kTimestamp);
      EXPECT_EQ(desc->display_map_version, 5U);
      EXPECT_EQ(desc->stride, 8U);
      EXPECT_EQ(next->desc().capture_timestamp_ns, kTimestamp);
      EXPECT_THAT(next->pixels(), ElementsAreArray(pixels));
      next.reset();
      EXPECT_EQ(next_pool.free_count(), 1U);
    }

    TEST_F(ScreenCaptureTest, Pw23ProbeConsumesReadyReadbackWithoutMapping) {
      initialize();
      const InSequence sequence;
      expect_submitted_frame();
      poll(PlatformError::kTimeout);
      poll(PlatformError::kTimeout);
      poll();
      acquire(kLayout, kTimestamp + 40'000'000);
      release();
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      seed_frame(*frame);
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      EXPECT_THAT(capture_.acquire_frame(nullptr, 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      auto result = capture_.acquire_frame(nullptr, 10ms);
      ASSERT_TRUE(std::holds_alternative<FrameDesc>(result));
      EXPECT_EQ(std::get<FrameDesc>(result).capture_timestamp_ns, kTimestamp);
      EXPECT_EQ(std::get<FrameDesc>(result).display_map_version, 5U);
      expect_seeded_frame(*frame);
      result = capture_.acquire_frame(nullptr, 10ms);
      ASSERT_TRUE(std::holds_alternative<FrameDesc>(result));
      EXPECT_EQ(std::get<FrameDesc>(result).capture_timestamp_ns,
                kTimestamp + 40'000'000);
    }

    TEST_F(ScreenCaptureTest, Pw24RechecksMappingAfterReleasingTheSourceFrame) {
      initialize();
      const InSequence sequence;
      acquire(kLayout);
      submit();
      EXPECT_CALL(backend_, release_frame()).WillOnce([this] {
        backend_.observed_change = CaptureLayout{2, 2, 8, 144};
        return PlatformResult<void>{std::monostate{}};
      });
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      seed_frame(*frame);
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kDisplayChanged));
      expect_seeded_frame(*frame);
      const auto display = std::get<DisplayInfo>(capture_.display_info());
      EXPECT_EQ(display.dpi, 144U);
      EXPECT_EQ(display.display_map_version, 6U);
      poll();
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      expect_seeded_frame(*frame);
    }

    TEST_F(ScreenCaptureTest,
           Pw24ResizeAndDpiDiscardReadbackBeforeReusingStaging) {
      for (const auto layout :
           {CaptureLayout{3, 1, 12, 120}, CaptureLayout{2, 2, 8, 144}}) {
        SCOPED_TRACE(layout.dpi);
        ::testing::StrictMock<MockCaptureBackend> backend;
        ScreenCaptureWin capture{
            backend,
            {[](const void*) noexcept { return DesktopState::kInteractive; },
             nullptr}};
        const InSequence sequence;
        EXPECT_CALL(backend, initialize(_))
            .WillOnce(Return(PlatformResult<CaptureLayout>{kLayout}));
        EXPECT_CALL(backend, acquire(10))
            .WillOnce(Return(PlatformResult<CaptureSample>{
                CaptureSample{kLayout, kTimestamp}}));
        EXPECT_CALL(backend, submit_readback())
            .WillOnce(Return(PlatformResult<void>{std::monostate{}}));
        EXPECT_CALL(backend, release_frame())
            .WillOnce(Return(PlatformResult<void>{std::monostate{}}));
        EXPECT_CALL(backend, poll_readback())
            .WillOnce(Return(PlatformResult<void>{PlatformError::kTimeout}));
        backend.clock_ns = kTimestamp;
        EXPECT_THAT(capture.initialize({.initial_display_map_version = 5}),
                    VariantWith<std::monostate>(std::monostate{}));
        FramePool pool{1, 16};
        auto frame = borrow_frame(pool);
        seed_frame(*frame);
        EXPECT_THAT(capture.acquire_frame(frame.get(), 10ms),
                    VariantWith<PlatformError>(PlatformError::kTimeout));
        backend.observed_change = layout;
        EXPECT_THAT(capture.acquire_frame(frame.get(), 10ms),
                    VariantWith<PlatformError>(PlatformError::kDisplayChanged));
        expect_seeded_frame(*frame);
        const auto display = capture.display_info();
        ASSERT_TRUE(std::holds_alternative<DisplayInfo>(display));
        EXPECT_EQ(std::get<DisplayInfo>(display).display_map_version, 6U);
        EXPECT_EQ(std::get<DisplayInfo>(display).width, layout.width);
        EXPECT_EQ(std::get<DisplayInfo>(display).dpi, layout.dpi);
        backend.observed_change.reset();
        EXPECT_CALL(backend, poll_readback())
            .WillOnce(Return(PlatformResult<void>{PlatformError::kTimeout}))
            .WillOnce(Return(PlatformResult<void>{std::monostate{}}));
        EXPECT_THAT(capture.acquire_frame(frame.get(), 10ms),
                    VariantWith<PlatformError>(PlatformError::kTimeout));
        EXPECT_THAT(capture.acquire_frame(frame.get(), 10ms),
                    VariantWith<PlatformError>(PlatformError::kTimeout));
        expect_seeded_frame(*frame);
        EXPECT_CALL(backend, acquire(10))
            .WillOnce(Return(PlatformResult<CaptureSample>{
                CaptureSample{layout, kTimestamp + 4'000'000}}));
        EXPECT_CALL(backend, release_frame())
            .WillOnce(Return(PlatformResult<void>{std::monostate{}}));
        const auto next = capture.acquire_frame(nullptr, 10ms);
        ASSERT_TRUE(std::holds_alternative<FrameDesc>(next));
        EXPECT_EQ(std::get<FrameDesc>(next).display_map_version, 6U);
        EXPECT_EQ(std::get<FrameDesc>(next).capture_timestamp_ns,
                  kTimestamp + 4'000'000);
      }
    }

    TEST_F(ScreenCaptureTest,
           Pw24DesktopRecoveryNeverDeliversThePreviousReadback) {
      initialize();
      const InSequence sequence;
      expect_submitted_frame();
      poll(PlatformError::kTimeout);
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      seed_frame(*frame);
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      desktop_ = DesktopState::kLocked;
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kSecureDesktop));
      desktop_ = DesktopState::kUnknown;
      EXPECT_THAT(
          capture_.acquire_frame(frame.get(), 10ms),
          VariantWith<PlatformError>(PlatformError::kSessionNotInteractive));
      desktop_ = DesktopState::kInteractive;
      poll(PlatformError::kTimeout);
      poll();
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      expect_seeded_frame(*frame);
      expect_submitted_frame(kTimestamp + 5'000'000);
      poll();
      const std::array<std::byte, 16> pixels{};
      map(pixels, 8);
      const auto result = capture_.acquire_frame(frame.get(), 10ms);
      ASSERT_TRUE(std::holds_alternative<FrameDesc>(result));
      EXPECT_EQ(std::get<FrameDesc>(result).capture_timestamp_ns,
                kTimestamp + 5'000'000);
    }

    TEST_F(ScreenCaptureTest, Pw25ReleaseFailureOverridesSubmissionFailure) {
      initialize();
      const InSequence sequence;
      acquire(kLayout);
      submit(PlatformError::kNotSupported);
      EXPECT_CALL(backend_, release_frame())
          .WillOnce(Return(PlatformResult<void>{PlatformError::kAccessLost}));
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      seed_frame(*frame);
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kAccessLost));
      EXPECT_THAT(capture_.acquire_frame(nullptr, 10ms),
                  VariantWith<PlatformError>(PlatformError::kAccessLost));
      expect_seeded_frame(*frame);
    }

    TEST_F(ScreenCaptureTest,
           Pw25FailedSubmitReleasesSourceAndDoesNotStartReadback) {
      initialize();
      const InSequence sequence;
      acquire(kLayout);
      submit(PlatformError::kDisplayChanged);
      release();
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      seed_frame(*frame);
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kDisplayChanged));
      expect_seeded_frame(*frame);
      acquire(kLayout);
      release();
      EXPECT_TRUE(std::holds_alternative<FrameDesc>(
          capture_.acquire_frame(nullptr, 10ms)));
    }

    TEST_F(ScreenCaptureTest, Pw25QueryDeviceFailureRequiresRebuild) {
      initialize();
      const InSequence sequence;
      expect_submitted_frame();
      poll(PlatformError::kUnavailable);
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      seed_frame(*frame);
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kUnavailable));
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kUnavailable));
      expect_seeded_frame(*frame);
    }

    TEST_F(ScreenCaptureTest, Pw25MapDeviceFailureRequiresRebuild) {
      initialize();
      const InSequence sequence;
      expect_submitted_frame();
      poll();
      EXPECT_CALL(backend_, map_pixels())
          .WillOnce(Return(
              PlatformResult<MappedCapture>{PlatformError::kAccessLost}));
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      seed_frame(*frame);
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kAccessLost));
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kAccessLost));
      expect_seeded_frame(*frame);
    }

    TEST_F(ScreenCaptureTest, Pw25SmallDestinationStillAllowsAnotherReadback) {
      initialize();
      const InSequence sequence;
      const std::array<std::byte, 16> pixels{};
      expect_submitted_frame();
      poll();
      map(pixels, 8);
      expect_submitted_frame(kTimestamp + 2'000'000);
      poll();
      map(pixels, 8);
      FramePool small{1, 8};
      auto frame = borrow_frame(small);
      seed_frame(*frame);
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kInvalidArgument));
      expect_seeded_frame(*frame);
      FramePool full{1, 16};
      auto next = borrow_frame(full);
      const auto result = capture_.acquire_frame(next.get(), 10ms);
      ASSERT_TRUE(std::holds_alternative<FrameDesc>(result));
      EXPECT_EQ(std::get<FrameDesc>(result).capture_timestamp_ns,
                kTimestamp + 2'000'000);
      EXPECT_THAT(next->pixels(), ElementsAreArray(pixels));
    }

    TEST_F(ScreenCaptureTest,
           Pw26ExpiredReadbackDoesNotAdvanceTheLastDeliveredTimestamp) {
      initialize();
      const InSequence sequence;
      acquire(kLayout, kTimestamp - 40'000'000);
      release();
      expect_submitted_frame();
      poll(PlatformError::kTimeout);
      poll(PlatformError::kTimeout);
      poll();
      expect_submitted_frame(kTimestamp + 33'000'000);
      poll();
      const std::array<std::byte, 16> pixels{};
      map(pixels, 8);

      EXPECT_TRUE(std::holds_alternative<FrameDesc>(
          capture_.acquire_frame(nullptr, 10ms)));
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      seed_frame(*frame);
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      backend_.clock_ns = kTimestamp + 33'000'000;
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      expect_seeded_frame(*frame);
      const auto result = capture_.acquire_frame(frame.get(), 10ms);
      ASSERT_TRUE(std::holds_alternative<FrameDesc>(result));
      EXPECT_EQ(std::get<FrameDesc>(result).capture_timestamp_ns,
                kTimestamp + 33'000'000);
      EXPECT_EQ(std::get<FrameDesc>(result).display_map_version, 5U);
    }

    TEST_F(ScreenCaptureTest,
           Pw26ReadbackThatExpiresDuringMapIsUnmappedAndDiscarded) {
      initialize();
      const InSequence sequence;
      expect_submitted_frame();
      poll();
      const std::array<std::byte, 16> pixels{};
      EXPECT_CALL(backend_, map_pixels()).WillOnce([&] {
        backend_.clock_ns = kTimestamp + 33'000'000;
        return PlatformResult<MappedCapture>{MappedCapture{pixels, 8}};
      });
      EXPECT_CALL(backend_, unmap_pixels());
      FramePool pool{1, 16};
      auto frame = borrow_frame(pool);
      seed_frame(*frame);
      EXPECT_THAT(capture_.acquire_frame(frame.get(), 10ms),
                  VariantWith<PlatformError>(PlatformError::kTimeout));
      expect_seeded_frame(*frame);
    }

    TEST_F(ScreenCaptureTest, PositiveTimeoutNeverUsesInfiniteWait) {
      initialize();
      EXPECT_CALL(backend_,
                  acquire(std::numeric_limits<std::uint32_t>::max() - 1))
          .WillOnce(
              Return(PlatformResult<CaptureSample>{PlatformError::kTimeout}));
      EXPECT_THAT(
          capture_.acquire_frame(nullptr, std::chrono::milliseconds::max()),
          VariantWith<PlatformError>(PlatformError::kTimeout));
    }
  }  // namespace
}  // namespace rd::platform::win
