// Windows desktop observer and its scripted event source interface.
// Thread: session only (the event source publishes observations).
#pragma once

#include <optional>

#include "remotedesktop/platform/platform.h"

namespace rd::platform::win {

  class DesktopEventSource {
   public:
    // Snapshot and callback registration are ordered by the source.
    virtual PlatformResult<DesktopObservation> arm(
        LocalSessionGeneration, DesktopObserver, void*) noexcept = 0;
    virtual void disarm(LocalSessionGeneration) noexcept = 0;
    virtual ~DesktopEventSource() = default;
  };

  class SessionStateWin final : public SessionState {
   public:
    explicit SessionStateWin(DesktopEventSource& source) noexcept;
    ~SessionStateWin() override;

    SessionStateWin(const SessionStateWin&) = delete;
    SessionStateWin& operator=(const SessionStateWin&) = delete;

    PlatformResult<DesktopObservation> subscribe(
        LocalSessionGeneration, DesktopObserver, void*) noexcept override;
    void unsubscribe(LocalSessionGeneration) noexcept override;

   private:
    DesktopEventSource& source_;
    std::optional<LocalSessionGeneration> generation_;
  };

}  // namespace rd::platform::win
