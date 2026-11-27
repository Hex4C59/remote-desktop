// Session-scoped reader for the latest desktop observation.
// Thread: any
#pragma once

#include "remotedesktop/platform/platform.h"

namespace rd::platform::win {
  struct DesktopStateReader {
    DesktopState (*read)(const void*) noexcept {};
    const void* context{};

    // The owner supplies its existing latest-state slot and keeps it alive.
    DesktopState state() const noexcept {
      return read != nullptr ? read(context) : DesktopState::kUnknown;
    }
  };
}  // namespace rd::platform::win
