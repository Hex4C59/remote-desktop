#ifndef REMOTE_DESKTOP_PROBE_PAIRING_SERVER_H_
#define REMOTE_DESKTOP_PROBE_PAIRING_SERVER_H_
#include <memory>
#include <string>
namespace desktop_probe {
// One authenticated TLS connection owns one media session. All network I/O is
// off the capture/signaling threads. Queues are bounded; overflow ends session.
class PairingServer {
 public:
  PairingServer();
  ~PairingServer();
  bool Start();
  bool Authorized() const;
  bool Ended() const;
  bool Send(std::string message);
  bool Receive(std::string& message);
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}
#endif
