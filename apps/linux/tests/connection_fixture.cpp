// Diagnostic seams: concurrent causes and an inherited stdout pipe that stalls.
#include "remote_desktop_probe/connection_diagnostics.h"
#include <algorithm>
#include <array>
#include <cstdlib>
#include <iostream>
#include <span>
#include <thread>
#include <vector>

namespace {
std::string ReadAvailable(int fd) {
  std::string text;
  std::array<char, 4096> bytes;
  for (;;) {
    const auto count = read(fd, bytes.data(), bytes.size());
    if (count <= 0) break;
    const auto part = std::span(bytes).first(static_cast<size_t>(count));
    text.append(part.begin(), part.end());
  }
  return text;
}
}
int main() {
#if defined(CONNECTION_DIAGNOSTICS_BACKPRESSURE_TEST)
  std::array<int, 2> pipe_fds;
  if (pipe(pipe_fds.data()) != 0) return 1;
  const int flags = fcntl(pipe_fds[1], F_GETFL);
  if (fcntl(pipe_fds[1], F_SETFL, flags | O_NONBLOCK) != 0) return 1;
  std::array<char, 4096> fill {};
  while (write(pipe_fds[1], fill.data(), fill.size()) > 0) {}
  if (fcntl(pipe_fds[1], F_SETFL, flags) != 0) return 1;
  desktop_probe::ConnectionDiagnostics diagnostics(pipe_fds[1]);
  // If the logger ever reintroduces blocking pipe writes, the parent timeout
  // catches this exact stalled-consumer pattern. No reader is running yet.
  for (int n = 0; n < 300; ++n) diagnostics.Event("ice_state", "connected");
  diagnostics.Stop("peer_disconnected", "peer_state", "disconnected");
  if (fcntl(pipe_fds[1], F_GETFL) != flags) return 1;
  fcntl(pipe_fds[0], F_SETFL, O_NONBLOCK);
  ReadAvailable(pipe_fds[0]);
  for (int attempt = 0; attempt < 16; ++attempt) {
    diagnostics.Finish(0);
    std::cout << ReadAvailable(pipe_fds[0]);
  }
  close(pipe_fds[0]); close(pipe_fds[1]);
#else
  std::array<char, 32> name {};
  const std::string pattern = "/tmp/linux-diagnostics-XXXXXX";
  std::copy(pattern.begin(), pattern.end(), name.begin());
  const int fd = mkstemp(name.data());
  if (fd < 0) return 1;
  unlink(name.data());
  desktop_probe::ConnectionDiagnostics diagnostics(fd);
  diagnostics.Event("peer_state", "connected");
  diagnostics.Event("tls_state", "peer_closed");
  diagnostics.Stop("tls_peer_closed", "tls_state", "peer_closed");
  std::vector<std::thread> workers;
  for (int i = 0; i < 4; ++i) workers.emplace_back([&] {
    for (int n = 0; n < 20; ++n) diagnostics.Event("ice_state", "disconnected");
    diagnostics.Stop("local_stop");
  });
  for (auto& worker : workers) worker.join();
  diagnostics.Event("sdp", "secret\ncredential=abc");
  diagnostics.Event("127.0.0.1", "192.168.1.2");
  diagnostics.Finish(0);
  lseek(fd, 0, SEEK_SET);
  std::cout << ReadAvailable(fd);
  close(fd);
#endif
}
