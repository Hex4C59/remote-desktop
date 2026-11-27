// Shared packet flags and batch bounds for the Windows input adapter.
// Thread: input only
#pragma once

#include "remotedesktop/platform/win/input_inject_win.h"

namespace rd::platform::win {
  inline constexpr std::size_t kMaxInputPackets = 512;
  inline constexpr std::uint32_t kMouseMove = 0x0001;
  inline constexpr std::uint32_t kMouseLeftDown = 0x0002;
  inline constexpr std::uint32_t kMouseLeftUp = 0x0004;
  inline constexpr std::uint32_t kMouseRightDown = 0x0008;
  inline constexpr std::uint32_t kMouseRightUp = 0x0010;
  inline constexpr std::uint32_t kMouseMiddleDown = 0x0020;
  inline constexpr std::uint32_t kMouseMiddleUp = 0x0040;
  inline constexpr std::uint32_t kMouseWheel = 0x0800;
  inline constexpr std::uint32_t kMouseVirtualDesk = 0x4000;
  inline constexpr std::uint32_t kMouseAbsolute = 0x8000;
  inline constexpr std::uint32_t kKeyExtended = 0x0001;
  inline constexpr std::uint32_t kKeyUp = 0x0002;
  inline constexpr std::uint32_t kKeyUnicode = 0x0004;

  InputSystemWin native_input_system() noexcept;
}  // namespace rd::platform::win
