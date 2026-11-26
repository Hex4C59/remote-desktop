// Windows desktop observations and the boundary to the native message source.
// Thread: session only
#pragma once

#include <memory>
#include <optional>

#include "remotedesktop/platform/win/session_state_win.h"

namespace rd::platform::win {

  enum class DesktopSignal { kLock, kLogoff, kDisconnect, kRecheck, kDesktopSwitch };
  enum class SessionEvidence { kUnknown, kLocked, kUnlocked };
  enum class InputDesktopEvidence { kUnknown, kDefault, kSecure };

  struct DesktopEvidence {
    SessionEvidence session{SessionEvidence::kUnknown};
    InputDesktopEvidence desktop{InputDesktopEvidence::kUnknown};
  };

  using DesktopSignalSink = void (*)(void*, DesktopSignal) noexcept;

  class DesktopSignals {
   public:
    // Deliver signals on the calling Session thread. A failed start rolls back registration.
    virtual PlatformResult<void> start(DesktopSignalSink, void*) noexcept = 0;
    virtual void stop() noexcept = 0;
    virtual void pump() noexcept = 0;
    virtual DesktopEvidence probe() noexcept = 0;
    virtual ~DesktopSignals() = default;
  };

  class DesktopEventSourceWin final : public DesktopEventSource {
   public:
    DesktopEventSourceWin();
    explicit DesktopEventSourceWin(DesktopSignals&) noexcept;
    ~DesktopEventSourceWin() override;

    DesktopEventSourceWin(const DesktopEventSourceWin&) = delete;
    DesktopEventSourceWin& operator=(const DesktopEventSourceWin&) = delete;

    PlatformResult<DesktopObservation> arm(
        LocalSessionGeneration, DesktopObserver, void*) noexcept override;
    void disarm(LocalSessionGeneration) noexcept override;
    // Call from the existing Session loop to dispatch signals and reconcile desktop state.
    void pump_notifications() noexcept;

   private:
    struct Subscription {
      LocalSessionGeneration generation;
      DesktopObserver observer;
      void* context;
      std::uint64_t sequence{1};
      std::optional<DesktopState> latest;
    };

    static void receive_signal(void*, DesktopSignal) noexcept;
    void on_signal(DesktopSignal) noexcept;
    void publish(DesktopState) noexcept;

    std::unique_ptr<DesktopSignals> owned_signals_;
    DesktopSignals* signals_{};
    std::optional<Subscription> subscription_;
    std::optional<DesktopState> session_block_;
    bool starting_{};
    bool probe_interrupted_{};
    bool refresh_pending_{};
  };

}  // namespace rd::platform::win
