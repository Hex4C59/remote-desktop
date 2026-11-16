#ifndef REMOTE_DESKTOP_LINUX_PAIRING_SERVER_H_
#define REMOTE_DESKTOP_LINUX_PAIRING_SERVER_H_
#include <memory>
#include <chrono>
#include <functional>
#include "remote_desktop_probe/connection_diagnostics.h"
#include <string>
namespace desktop_probe {
// GTK calls stay on the main thread. Each network worker owns its TLS socket;
// bounded queues connect the authenticated connection to one capture session.
class PairingServer {
 public:
  using Clock = std::chrono::steady_clock;
  explicit PairingServer(std::function<Clock::time_point()> now = Clock::now,
                         std::shared_ptr<ConnectionDiagnostics> diagnostics = nullptr);
  ~PairingServer();
  bool Start();
  bool Authorized() const;
  bool Ended() const;
  bool Send(std::string message);
  bool Receive(std::string& message);
  void Stop(std::string_view reason = "local_stop");
  void PollUi();
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}
#endif
