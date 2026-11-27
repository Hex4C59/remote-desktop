// Windows screen capture and the boundary to its desktop duplication resources.
// Thread: capture only
#pragma once

#include <cstddef>
#include <memory>
#include <optional>
#include <span>

#include "remotedesktop/platform/win/desktop_state_reader.h"

namespace rd::platform::win {
  struct CaptureLayout {
    std::uint32_t width{};
    std::uint32_t height{};
    std::uint32_t stride{};
    std::uint16_t dpi{96};
  };

  struct CaptureSample {
    CaptureLayout layout;
    std::uint64_t timestamp_ns{};
  };

  struct MappedCapture {
    std::span<const std::byte> bytes;
    std::uint32_t stride{};
  };

  class CaptureBackend {
   public:
    virtual PlatformResult<CaptureLayout> initialize(
        const CaptureConfig&) noexcept = 0;
    // Independently observed mapping changes can be reported before a frame is
    // held.
    virtual std::optional<CaptureLayout> observed_display_change(
        const DisplayInfo&) noexcept {
      return std::nullopt;
    }
    // Only success transfers a frame to the caller, who must release it once.
    virtual PlatformResult<CaptureSample> acquire(
        std::uint32_t timeout_ms) noexcept = 0;
    // Submit while the source frame is held, then poll without waiting.
    virtual PlatformResult<void> submit_readback() noexcept = 0;
    virtual PlatformResult<void> poll_readback() noexcept = 0;
    virtual std::uint64_t now_ns() const noexcept;
    // Only success needs unmap. The bytes are borrowed until then.
    virtual PlatformResult<MappedCapture> map_pixels() noexcept = 0;
    virtual void unmap_pixels() noexcept = 0;
    virtual PlatformResult<void> release_frame() noexcept = 0;
    virtual ~CaptureBackend() = default;
  };

  struct CaptureReadbackStats {
    std::uint64_t submitted{};
    std::uint64_t ready{};
    std::uint64_t discarded{};
    std::uint64_t query_busy{};
    std::uint64_t map_busy{};
  };

  class ScreenCaptureWin final : public ScreenCapture {
   public:
    ScreenCaptureWin();
    explicit ScreenCaptureWin(DesktopStateReader desktop);
    ScreenCaptureWin(CaptureBackend& backend,
                     DesktopStateReader desktop) noexcept;
    ~ScreenCaptureWin() override;

    PlatformResult<void> initialize(const CaptureConfig&) noexcept override;
    PlatformResult<FrameDesc> acquire_frame(
        Frame*, std::chrono::milliseconds) noexcept override;
    PlatformResult<DisplayInfo> display_info() const noexcept override;
    CaptureReadbackStats readback_stats() const noexcept {
      return readback_stats_;
    }

    ScreenCaptureWin(const ScreenCaptureWin&) = delete;
    ScreenCaptureWin& operator=(const ScreenCaptureWin&) = delete;

   private:
    struct PendingReadback {
      CaptureSample sample;
      std::uint32_t display_map_version;
      bool ready{};
      bool discarded{};
    };

    std::optional<PlatformError> observe_display_change() noexcept;
    std::optional<PlatformError> update_display(const CaptureLayout&) noexcept;
    PlatformResult<FrameDesc> finish_readback(Frame*) noexcept;
    FrameDesc deliver(FrameDesc) noexcept;
    bool frame_interval_elapsed(std::uint64_t timestamp_ns) const noexcept;
    void discard_readback() noexcept;
    bool readback_expired() const noexcept;

    std::unique_ptr<CaptureBackend> owned_backend_;
    CaptureBackend* backend_{};
    DesktopStateReader desktop_;
    DisplayInfo display_;
    std::optional<PendingReadback> readback_;
    std::optional<PlatformError> rebuild_error_;
    CaptureReadbackStats readback_stats_;
    std::uint64_t min_interval_ns_{};
    std::optional<std::uint64_t> last_frame_ns_;
    bool initialized_{};
  };
}  // namespace rd::platform::win
