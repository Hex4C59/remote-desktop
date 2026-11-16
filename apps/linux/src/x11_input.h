#ifndef REMOTE_DESKTOP_LINUX_X11_INPUT_H_
#define REMOTE_DESKTOP_LINUX_X11_INPUT_H_
#include <X11/Xlib.h>
#include <optional>
#include <string_view>
#include <vector>
#include "remote_desktop_probe/x11_display.h"
namespace desktop_probe {
// Construct, execute and destroy on the session's capture/input thread.
class X11Input {
 public:
  explicit X11Input(DesktopBounds bounds);
  ~X11Input();
  X11Input(const X11Input&) = delete;
  X11Input& operator=(const X11Input&) = delete;
  bool valid() const { return display_ && monitor_.has_value(); }
  bool Execute(std::string_view message);
 private:
  bool Release();
  struct KeyStroke { KeyCode code; bool shift; bool level3; };
  std::optional<KeyStroke> FindSymbol(KeySym symbol, unsigned int locked, int group);
  bool Press(KeyCode code);
  bool ReleaseKey(KeyCode code);
  Display* display_ = nullptr;
  std::optional<X11Monitor> monitor_;
  std::vector<KeyCode> held_;
  bool button_held_ = false;
};
}  // namespace desktop_probe
#endif
