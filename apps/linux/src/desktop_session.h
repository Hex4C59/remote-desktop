#ifndef REMOTE_DESKTOP_LINUX_DESKTOP_SESSION_H_
#define REMOTE_DESKTOP_LINUX_DESKTOP_SESSION_H_
#include <gio/gio.h>
#include <string>
namespace desktop_probe {
// Selects only the caller's explicit ordinary-user session. Never discovers or
// attaches to a greeter, another user's desktop, or a Wayland Xwayland display.
class DesktopSession {
 public:
  DesktopSession();
  ~DesktopSession();
  DesktopSession(const DesktopSession&) = delete;
  DesktopSession& operator=(const DesktopSession&) = delete;
  bool Available() const;
 private:
  GDBusConnection* bus_ = nullptr;
  std::string path_;
};
}  // namespace desktop_probe
#endif
