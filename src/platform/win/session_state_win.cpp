// Owns one desktop subscription while the event source orders its publications.
// Thread: session only
#include "remotedesktop/platform/win/session_state_win.h"

namespace rd::platform::win {
  SessionStateWin::SessionStateWin(DesktopEventSource& source) noexcept : source_(source) {}

  SessionStateWin::~SessionStateWin() {
    if (generation_) {
      unsubscribe(*generation_);
    }
  }

  PlatformResult<DesktopObservation> SessionStateWin::subscribe(
      LocalSessionGeneration generation, DesktopObserver observer, void* context) noexcept {
    if (generation_) {
      return PlatformError::kAlreadyInitialized;
    }
    const auto snapshot = source_.arm(generation, observer, context);
    if (std::holds_alternative<DesktopObservation>(snapshot)) {
      generation_ = generation;
    }
    return snapshot;
  }

  void SessionStateWin::unsubscribe(LocalSessionGeneration generation) noexcept {
    if (generation_ == generation) {
      generation_.reset();
      source_.disarm(generation);
    }
  }
}  // namespace rd::platform::win
