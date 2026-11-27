// Windows capture entry points and ownership of the capture backend.
// Thread: capture only
#include "remotedesktop/platform/win/screen_capture_win.h"

#include <algorithm>
#include <cstring>
#include <limits>

#include "remotedesktop/assert.h"

namespace rd::platform::win {
#ifdef _WIN32
  std::unique_ptr<CaptureBackend> make_desktop_duplication();
#endif

  namespace {
    constexpr std::uint32_t kBytesPerPixel = 4;
    constexpr std::uint64_t kNanosecondsPerSecond = 1'000'000'000;
    constexpr std::uint64_t kReadbackMaxAgeNs = 33'000'000;
    constexpr auto kMaxFiniteTimeout =
        std::numeric_limits<std::uint32_t>::max() - 1;

    PlatformError desktop_error(DesktopState state) noexcept {
      return state == DesktopState::kLocked ||
                     state == DesktopState::kSecureDesktop
                 ? PlatformError::kSecureDesktop
                 : PlatformError::kSessionNotInteractive;
    }

    bool valid_layout(const CaptureLayout& layout) noexcept {
      return layout.width != 0 && layout.height != 0 && layout.dpi != 0 &&
             layout.width <= layout.stride / kBytesPerPixel;
    }

    DisplayInfo display_from_layout(const CaptureLayout& layout,
                                    std::uint32_t version) noexcept {
      return {layout.width, layout.height, layout.dpi,
              static_cast<float>(layout.dpi) / 96.0F, version};
    }

    bool copy_rows(std::span<std::byte> destination,
                   const MappedCapture& source,
                   const FrameDesc& desc) noexcept {
      const auto stride = static_cast<std::size_t>(source.stride);
      const auto row_bytes =
          static_cast<std::size_t>(desc.width) * kBytesPerPixel;
      const auto height = static_cast<std::size_t>(desc.height);
      if (stride < row_bytes || height > destination.size() / stride ||
          source.bytes.size() < row_bytes ||
          (height - 1) > (source.bytes.size() - row_bytes) / stride) {
        return false;
      }
      for (std::size_t row = 0; row < height; ++row) {
        const auto offset = row * stride;
        std::memcpy(destination.data() + offset, source.bytes.data() + offset,
                    row_bytes);
        // Row padding is not desktop content and may contain uninitialized
        // driver data.
        std::memset(destination.data() + offset + row_bytes, 0,
                    stride - row_bytes);
      }
      return true;
    }
  }  // namespace

  std::uint64_t CaptureBackend::now_ns() const noexcept {
    const auto elapsed = std::chrono::steady_clock::now().time_since_epoch();
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed).count());
  }

  ScreenCaptureWin::ScreenCaptureWin()
      : ScreenCaptureWin(DesktopStateReader{}) {}
#ifdef _WIN32
  ScreenCaptureWin::ScreenCaptureWin(DesktopStateReader desktop)
      : owned_backend_(make_desktop_duplication()),
        backend_(owned_backend_.get()),
        desktop_(desktop) {}
#else
  ScreenCaptureWin::ScreenCaptureWin(DesktopStateReader desktop)
      : desktop_(desktop) {}
#endif
  ScreenCaptureWin::ScreenCaptureWin(CaptureBackend& backend,
                                     DesktopStateReader desktop) noexcept
      : backend_(&backend), desktop_(desktop) {}
  ScreenCaptureWin::~ScreenCaptureWin() = default;

  PlatformResult<void> ScreenCaptureWin::initialize(
      const CaptureConfig& config) noexcept {
    if (initialized_) {
      RD_ASSERT_MSG(false, "capture already initialized");
      return PlatformError::kAlreadyInitialized;
    }
    if (backend_ == nullptr) {
      return PlatformError::kNotSupported;
    }
    if (config.max_fps == 0) {
      return PlatformError::kInvalidArgument;
    }
    if (const auto state = desktop_.state();
        state != DesktopState::kInteractive) {
      return desktop_error(state);
    }

    const auto result = backend_->initialize(config);
    const auto* layout = std::get_if<CaptureLayout>(&result);
    if (layout == nullptr) {
      return std::get<PlatformError>(result);
    }
    if (!valid_layout(*layout)) {
      return PlatformError::kInternal;
    }
    display_ = display_from_layout(*layout, config.initial_display_map_version);
    min_interval_ns_ =
        (kNanosecondsPerSecond + config.max_fps - 1) / config.max_fps;
    initialized_ = true;
    return std::monostate{};
  }

  PlatformResult<FrameDesc> ScreenCaptureWin::acquire_frame(
      Frame* frame, std::chrono::milliseconds timeout) noexcept {
    if (!initialized_) {
      return PlatformError::kUnavailable;
    }
    if (rebuild_error_) {
      return *rebuild_error_;
    }
    if (const auto state = desktop_.state();
        state != DesktopState::kInteractive) {
      discard_readback();
      return desktop_error(state);
    }

    if (readback_) {
      return finish_readback(frame);
    }
    if (const auto error = observe_display_change()) {
      return *error;
    }

    using MillisecondsRep = std::chrono::milliseconds::rep;
    const auto timeout_ms = static_cast<std::uint32_t>(
        std::clamp<MillisecondsRep>(timeout.count(), 0, kMaxFiniteTimeout));
    if (timeout_ms == 0 && !frame_interval_elapsed(backend_->now_ns())) {
      return PlatformError::kTimeout;
    }
    const auto acquired = backend_->acquire(timeout_ms);
    const auto* sample = std::get_if<CaptureSample>(&acquired);
    if (sample == nullptr) {
      const auto error = std::get<PlatformError>(acquired);
      if (error == PlatformError::kAccessLost) {
        rebuild_error_ = error;
      }
      return error;
    }

    PlatformResult<void> prepared = std::monostate{};
    if (const auto state = desktop_.state();
        state != DesktopState::kInteractive) {
      prepared = desktop_error(state);
    } else if (const auto error = update_display(sample->layout)) {
      prepared = *error;
    } else if (!frame_interval_elapsed(sample->timestamp_ns)) {
      prepared = PlatformError::kTimeout;
    } else if (frame != nullptr) {
      prepared = backend_->submit_readback();
      if (std::holds_alternative<std::monostate>(prepared)) {
        ++readback_stats_.submitted;
        readback_.emplace(*sample, display_.display_map_version);
      }
    }

    const auto released = backend_->release_frame();
    if (const auto* error = std::get_if<PlatformError>(&released)) {
      discard_readback();
      rebuild_error_ = *error;
      return *error;
    }
    if (const auto* error = std::get_if<PlatformError>(&prepared)) {
      if (*error == PlatformError::kAccessLost) {
        rebuild_error_ = *error;
      }
      return *error;
    }
    if (readback_) {
      return finish_readback(frame);
    }
    if (const auto state = desktop_.state();
        state != DesktopState::kInteractive) {
      return desktop_error(state);
    }
    const auto& layout = sample->layout;
    return deliver({layout.width, layout.height, layout.stride,
                    PixelFormat::kBGRA8, sample->timestamp_ns,
                    display_.display_map_version});
  }

  std::optional<PlatformError>
  ScreenCaptureWin::observe_display_change() noexcept {
    if (const auto layout = backend_->observed_display_change(display_)) {
      return update_display(*layout);
    }
    return std::nullopt;
  }

  std::optional<PlatformError> ScreenCaptureWin::update_display(
      const CaptureLayout& layout) noexcept {
    if (!valid_layout(layout)) {
      return PlatformError::kInternal;
    }
    if (display_.width == layout.width && display_.height == layout.height &&
        display_.dpi == layout.dpi) {
      return std::nullopt;
    }
    if (display_.display_map_version ==
        std::numeric_limits<std::uint32_t>::max()) {
      RD_ASSERT_MSG(false, "exhausted display map version");
      return PlatformError::kInternal;
    }
    display_ = display_from_layout(layout, display_.display_map_version + 1);
    return PlatformError::kDisplayChanged;
  }

  void ScreenCaptureWin::discard_readback() noexcept {
    if (readback_ && !readback_->discarded) {
      readback_->discarded = true;
      ++readback_stats_.discarded;
    }
  }

  bool ScreenCaptureWin::readback_expired() const noexcept {
    const auto now = backend_->now_ns();
    const auto captured = readback_->sample.timestamp_ns;
    return now >= captured && now - captured >= kReadbackMaxAgeNs;
  }

  bool ScreenCaptureWin::frame_interval_elapsed(
      std::uint64_t timestamp_ns) const noexcept {
    return !last_frame_ns_ ||
           (timestamp_ns >= *last_frame_ns_ &&
            timestamp_ns - *last_frame_ns_ >= min_interval_ns_);
  }

  FrameDesc ScreenCaptureWin::deliver(FrameDesc desc) noexcept {
    last_frame_ns_ = desc.capture_timestamp_ns;
    return desc;
  }

  PlatformResult<FrameDesc> ScreenCaptureWin::finish_readback(
      Frame* frame) noexcept {
    if (const auto state = desktop_.state();
        state != DesktopState::kInteractive) {
      discard_readback();
      return desktop_error(state);
    }
    if (const auto error = observe_display_change()) {
      discard_readback();
      return *error;
    }
    if (!readback_->discarded && readback_expired()) {
      discard_readback();
    }
    if (!readback_->ready) {
      const auto completion = backend_->poll_readback();
      if (const auto* error = std::get_if<PlatformError>(&completion)) {
        if (*error == PlatformError::kTimeout) {
          ++readback_stats_.query_busy;
        } else {
          discard_readback();
          rebuild_error_ = *error;
        }
        return *error;
      }
      readback_->ready = true;
      ++readback_stats_.ready;
    }
    if (readback_->discarded || readback_expired()) {
      discard_readback();
      readback_.reset();
      return PlatformError::kTimeout;
    }
    if (const auto state = desktop_.state();
        state != DesktopState::kInteractive) {
      discard_readback();
      readback_.reset();
      return desktop_error(state);
    }

    const auto& sample = readback_->sample;
    FrameDesc desc{sample.layout.width,  sample.layout.height,
                   sample.layout.stride, PixelFormat::kBGRA8,
                   sample.timestamp_ns,  readback_->display_map_version};
    if (frame == nullptr) {
      readback_.reset();
      return deliver(desc);
    }

    const auto mapped = backend_->map_pixels();
    const auto* source = std::get_if<MappedCapture>(&mapped);
    if (source == nullptr) {
      const auto error = std::get<PlatformError>(mapped);
      if (error == PlatformError::kTimeout) {
        ++readback_stats_.map_busy;
      } else {
        discard_readback();
        rebuild_error_ = error;
      }
      return error;
    }

    const auto copy_error = [&]() -> std::optional<PlatformError> {
      if (const auto state = desktop_.state();
          state != DesktopState::kInteractive) {
        return desktop_error(state);
      }
      if (readback_expired()) {
        return PlatformError::kTimeout;
      }
      if (!copy_rows(frame->mutable_pixels(), *source, desc)) {
        return PlatformError::kInvalidArgument;
      }
      return std::nullopt;
    }();
    backend_->unmap_pixels();
    if (copy_error) {
      discard_readback();
      readback_.reset();
      return *copy_error;
    }
    readback_.reset();
    desc.stride = source->stride;
    *frame->mutable_desc() = desc;
    return deliver(desc);
  }

  PlatformResult<DisplayInfo> ScreenCaptureWin::display_info() const noexcept {
    if (!initialized_) {
      return PlatformError::kUnavailable;
    }
    return display_;
  }
}  // namespace rd::platform::win
