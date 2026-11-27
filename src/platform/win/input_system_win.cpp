// Submits fixed-size input packets through the Windows SDK.
// Thread: input only
#include "input_system_win.h"

#include <array>

#include <windows.h>

namespace rd::platform::win {
  namespace {
    static_assert(kMouseMove == MOUSEEVENTF_MOVE);
    static_assert(kMouseLeftDown == MOUSEEVENTF_LEFTDOWN &&
                  kMouseLeftUp == MOUSEEVENTF_LEFTUP);
    static_assert(kMouseRightDown == MOUSEEVENTF_RIGHTDOWN &&
                  kMouseRightUp == MOUSEEVENTF_RIGHTUP);
    static_assert(kMouseMiddleDown == MOUSEEVENTF_MIDDLEDOWN &&
                  kMouseMiddleUp == MOUSEEVENTF_MIDDLEUP);
    static_assert(kMouseWheel == MOUSEEVENTF_WHEEL);
    static_assert(kMouseVirtualDesk == MOUSEEVENTF_VIRTUALDESK &&
                  kMouseAbsolute == MOUSEEVENTF_ABSOLUTE);
    static_assert(kKeyExtended == KEYEVENTF_EXTENDEDKEY &&
                  kKeyUp == KEYEVENTF_KEYUP &&
                  kKeyUnicode == KEYEVENTF_UNICODE);

    class PerMonitorDpiContext {
     public:
      PerMonitorDpiContext() noexcept
          : previous_(SetThreadDpiAwarenessContext(
                DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
        if (previous_ == nullptr) {
          previous_ = SetThreadDpiAwarenessContext(
              DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE);
        }
      }

      ~PerMonitorDpiContext() {
        if (previous_ != nullptr) {
          SetThreadDpiAwarenessContext(previous_);
        }
      }

      PerMonitorDpiContext(const PerMonitorDpiContext&) = delete;
      PerMonitorDpiContext& operator=(const PerMonitorDpiContext&) = delete;
      bool active() const noexcept { return previous_ != nullptr; }

     private:
      DPI_AWARENESS_CONTEXT previous_;
    };

    VirtualDesktopBounds virtual_desktop(void*) noexcept {
      const PerMonitorDpiContext context;
      if (!context.active()) {
        return {};
      }
      return {GetSystemMetrics(SM_XVIRTUALSCREEN),
              GetSystemMetrics(SM_YVIRTUALSCREEN),
              GetSystemMetrics(SM_CXVIRTUALSCREEN),
              GetSystemMetrics(SM_CYVIRTUALSCREEN)};
    }

    std::size_t dispatch_packets(std::span<const InputPacket> packets,
                                 INPUT* native) noexcept {
      for (std::size_t i = 0; i < packets.size(); ++i) {
        const auto& packet = packets[i];
        auto& entry = native[i];
        if (packet.kind == InputPacketKind::kKeyboard) {
          entry.type = INPUT_KEYBOARD;
          entry.ki = KEYBDINPUT{packet.virtual_key, packet.scan_code,
                                packet.flags, 0, 0};
        } else {
          entry.type = INPUT_MOUSE;
          entry.mi = MOUSEINPUT{
              packet.x,     packet.y, static_cast<DWORD>(packet.wheel_delta),
              packet.flags, 0,        0};
        }
      }
      // The native API reports a count. It does not identify an accepted
      // subset.
      return SendInput(static_cast<UINT>(packets.size()), native,
                       sizeof(INPUT));
    }

    std::size_t submit_native(void*,
                              std::span<const InputPacket> packets) noexcept {
      if (packets.empty() || packets.size() > kMaxInputPackets) {
        return 0;
      }
      if (packets.size() == 1) {
        INPUT native{};
        const auto& packet = packets.front();
        if (packet.kind == InputPacketKind::kMouse &&
            (packet.flags & kMouseAbsolute) != 0) {
          // Use the same DPI context for querying bounds and sending absolute
          // coordinates.
          const PerMonitorDpiContext context;
          return context.active() ? dispatch_packets(packets, &native) : 0;
        }
        return dispatch_packets(packets, &native);
      }
      std::array<INPUT, kMaxInputPackets> native;
      return dispatch_packets(packets, native.data());
    }
  }  // namespace

  InputSystemWin native_input_system() noexcept {
    return {submit_native, virtual_desktop, nullptr};
  }
}  // namespace rd::platform::win
