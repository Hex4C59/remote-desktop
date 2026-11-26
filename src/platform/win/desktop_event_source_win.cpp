// Orders Windows desktop observations on the existing Session thread.
// Thread: session only
#include "remotedesktop/platform/win/desktop_event_source_win.h"

namespace rd::platform::win {
#ifdef _WIN32
  std::unique_ptr<DesktopSignals> make_desktop_signals_win();
#endif

  namespace {
    DesktopState classify(DesktopEvidence evidence) noexcept {
      if (evidence.session == SessionEvidence::kLocked) {
        return DesktopState::kLocked;
      }
      if (evidence.session != SessionEvidence::kUnlocked) {
        return DesktopState::kUnknown;
      }
      switch (evidence.desktop) {
        case InputDesktopEvidence::kDefault:
          return DesktopState::kInteractive;
        case InputDesktopEvidence::kSecure:
          return DesktopState::kSecureDesktop;
        case InputDesktopEvidence::kUnknown:
          return DesktopState::kUnknown;
      }
      return DesktopState::kUnknown;
    }
  }  // namespace

#ifdef _WIN32
  DesktopEventSourceWin::DesktopEventSourceWin()
      : owned_signals_(make_desktop_signals_win()), signals_(owned_signals_.get()) {}
#else
  DesktopEventSourceWin::DesktopEventSourceWin() = default;
#endif

  DesktopEventSourceWin::DesktopEventSourceWin(DesktopSignals& signals) noexcept
      : signals_(&signals) {}

  DesktopEventSourceWin::~DesktopEventSourceWin() {
    if (subscription_) {
      disarm(subscription_->generation);
    }
  }

  PlatformResult<DesktopObservation> DesktopEventSourceWin::arm(
      LocalSessionGeneration generation, DesktopObserver observer, void* context) noexcept {
    if (subscription_ || starting_) {
      return PlatformError::kAlreadyInitialized;
    }
    if (signals_ == nullptr) {
      return PlatformError::kNotSupported;
    }
    if (observer == nullptr) {
      return PlatformError::kInvalidArgument;
    }

    session_block_.reset();
    probe_interrupted_ = false;
    refresh_pending_ = false;
    starting_ = true;
    const auto result = signals_->start(&receive_signal, this);
    starting_ = false;
    if (const auto* failure = std::get_if<PlatformError>(&result)) {
      return *failure;
    }

    constexpr std::uint64_t kInitialSequence = 1;
    auto& subscription = subscription_.emplace(Subscription{generation, observer, context,
                                                             kInitialSequence, std::nullopt});
    auto state = session_block_.value_or(DesktopState::kUnknown);
    if (!probe_interrupted_) {
      state = classify(signals_->probe());
      if (probe_interrupted_ && subscription.sequence == kInitialSequence) {
        state = DesktopState::kUnknown;
      }
    }
    // A notification can arrive while probing. Keep the snapshot's original sequence.
    if (!subscription.latest) {
      subscription.latest = state;
    }
    return DesktopObservation{generation, kInitialSequence, state};
  }

  void DesktopEventSourceWin::disarm(LocalSessionGeneration generation) noexcept {
    if (subscription_ && subscription_->generation == generation) {
      subscription_.reset();
      signals_->stop();
    }
  }

  void DesktopEventSourceWin::pump_notifications() noexcept {
    if (!subscription_) {
      return;
    }
    signals_->pump();
    if (!refresh_pending_) {
      return;
    }
    refresh_pending_ = false;
    probe_interrupted_ = false;
    const auto state = classify(signals_->probe());
    if (!probe_interrupted_) {
      publish(state);
    }
  }

  void DesktopEventSourceWin::receive_signal(void* context, DesktopSignal signal) noexcept {
    static_cast<DesktopEventSourceWin*>(context)->on_signal(signal);
  }

  void DesktopEventSourceWin::on_signal(DesktopSignal signal) noexcept {
    if (!subscription_ && !starting_) {
      return;
    }
    probe_interrupted_ = true;
    switch (signal) {
      case DesktopSignal::kLock:
        session_block_ = DesktopState::kLocked;
        break;
      case DesktopSignal::kLogoff:
        session_block_ = DesktopState::kLoggedOut;
        break;
      case DesktopSignal::kDisconnect:
        session_block_ = DesktopState::kUnknown;
        break;
      case DesktopSignal::kRecheck:
        session_block_.reset();
        refresh_pending_ = true;
        return;
      case DesktopSignal::kDesktopSwitch:
        if (!session_block_) {
          publish(DesktopState::kUnknown);
          refresh_pending_ = true;
        }
        return;
    }
    refresh_pending_ = false;
    publish(*session_block_);
  }

  void DesktopEventSourceWin::publish(DesktopState state) noexcept {
    if (!subscription_ || subscription_->latest == state) {
      return;
    }
    auto& subscription = *subscription_;
    subscription.latest = state;
    subscription.observer(subscription.context,
                          {subscription.generation, ++subscription.sequence, state});
  }
}  // namespace rd::platform::win
