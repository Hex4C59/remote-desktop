#ifndef REMOTE_DESKTOP_LINUX_CONNECTION_DIAGNOSTICS_H_
#define REMOTE_DESKTOP_LINUX_CONNECTION_DIAGNOSTICS_H_

#include <cerrno>
#include <chrono>
#include <cstdint>
#include <deque>
#include <fcntl.h>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

namespace desktop_probe {
// One instance spans GTK, TLS and RTC workers. Only fixed labels and counters
// belong here, never messages, addresses, SDP or credentials. Stop only latches
// memory: authorization must be revoked before any attempt to write diagnostics.
class ConnectionDiagnostics {
 public:
  explicit ConnectionDiagnostics(int output = STDOUT_FILENO)
      : started_(std::chrono::steady_clock::now()) {
    struct stat info {};
    if (fstat(output, &info) != 0) return;
    if (S_ISFIFO(info.st_mode) || S_ISCHR(info.st_mode)) {
#if defined(__linux__)
      // dup shares O_NONBLOCK with the caller. Reopen pipes/terminals through
      // proc instead, so logging cannot change the inherited stdout flags.
      const auto path = "/proc/self/fd/" + std::to_string(output);
      output_ = open(path.c_str(), O_WRONLY | O_NONBLOCK | O_CLOEXEC | O_NOCTTY);
#endif
    } else {
      output_ = fcntl(output, F_DUPFD_CLOEXEC, 0);
      socket_ = S_ISSOCK(info.st_mode);
    }
  }
  ~ConnectionDiagnostics() { if (output_ >= 0) close(output_); }

  void Event(std::string_view event, std::string_view value,
             std::optional<int64_t> number = std::nullopt) {
    {
      std::lock_guard lock(mutex_);
      Enqueue(event, value, number, false);
    }
    Drain();
  }
  // A terminal boundary event and its first stop are latched atomically. Later
  // cleanup events can be retained, but cannot steal the original stop reason.
  void Stop(std::string_view reason, std::string_view event = {},
            std::string_view value = {}) {
    std::lock_guard lock(mutex_);
    if (!event.empty()) Enqueue(event, value, std::nullopt, false);
    if (!stop_reason_.empty()) return;
    stop_reason_ = Label(reason);
    Enqueue("stop_requested", stop_reason_, std::nullopt, true);
  }
  void Finish(int exit_code) {
    {
      std::lock_guard lock(mutex_);
      if (!finished_ && stop_reason_.empty()) {
        stop_reason_ = "worker_finished";
        Enqueue("stop_requested", stop_reason_, std::nullopt, true);
      }
      if (!finished_) Enqueue("session_finished", stop_reason_, exit_code, true);
      finished_ = true;
    }
    Drain();
  }

 private:
  struct Record {
    std::string event, value;
    std::optional<int64_t> number;
    int64_t elapsed, utc;
    bool terminal;
    uint64_t dropped_total = 0;
  };
  static constexpr size_t kMaxQueuedEvents = 256;
  static std::string_view Label(std::string_view value) {
    if (value.empty() || value.size() > 48) return "unknown";
    for (const char c : value)
      if ((c < 'a' || c > 'z') && c != '_') return "unknown";
    return value;
  }
  Record MakeRecord(std::string_view event, std::string_view value,
                    std::optional<int64_t> number, bool terminal) const {
    return {std::string(Label(event)), std::string(Label(value)), number,
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - started_).count(),
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count(), terminal};
  }
  void Enqueue(std::string_view event, std::string_view value,
               std::optional<int64_t> number, bool terminal) {
    if (pending_.size() == kMaxQueuedEvents) {
      ++dropped_;
      ++dropped_total_;
      if (!terminal) return;
      // Keep stop/finish even under backpressure. Never evict another terminal
      // record. At most one first stop and one finish are enqueued by a session.
      auto item = pending_.end();
      while (item != pending_.begin()) {
        --item;
        if (!item->terminal) { pending_.erase(item); break; }
      }
      if (pending_.size() == kMaxQueuedEvents) return;
    }
    pending_.push_back(MakeRecord(event, value, number, terminal));
  }
  void Drain() {
    std::unique_lock output_lock(output_mutex_, std::try_to_lock);
    if (!output_lock || output_ < 0 || output_failed_) return;
    // No I/O holds the state mutex. Writes to pipes/terminals and sockets are
    // nonblocking; one bounded drain also prevents an active producer starving
    // the caller. Incomplete/dropped output is rejected by the analyzer.
    for (size_t attempt = 0; attempt <= kMaxQueuedEvents; ++attempt) {
      Record record;
      bool overflow = false;
      {
        std::lock_guard lock(mutex_);
        if (pending_.empty()) {
          if (!dropped_) return;
          overflow = true;
          record = MakeRecord("events_dropped", "overflow", dropped_, false);
        } else record = pending_.front();
        record.dropped_total = dropped_total_;
      }
      std::string line = "connection_event={\"schema\":1,\"seq\":" +
          std::to_string(sequence_ + 1) + ",\"elapsed_ms\":" + std::to_string(record.elapsed) +
          ",\"utc_ms\":" + std::to_string(record.utc) + ",\"event\":\"" +
          record.event + "\",\"value\":\"" + record.value + "\"";
      if (record.event == "session_finished")
        line += ",\"dropped_events\":" + std::to_string(record.dropped_total);
      if (record.number) line += ",\"number\":" + std::to_string(*record.number);
      line += "}\n";
      // Each line is below PIPE_BUF; pipe writes are either complete or EAGAIN.
      const auto written = socket_ ? send(output_, line.data(), line.size(), MSG_DONTWAIT)
                                   : write(output_, line.data(), line.size());
      if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return;
      if (written != static_cast<ssize_t>(line.size())) { output_failed_ = true; return; }
      ++sequence_;
      std::lock_guard lock(mutex_);
      if (overflow) dropped_ -= static_cast<uint64_t>(*record.number);
      else pending_.pop_front();
    }
  }
  const std::chrono::steady_clock::time_point started_;
  std::mutex mutex_, output_mutex_;
  std::deque<Record> pending_;
  uint64_t sequence_ = 0, dropped_ = 0, dropped_total_ = 0;
  std::string stop_reason_;
  int output_ = -1;
  bool socket_ = false, output_failed_ = false, finished_ = false;
};
}  // namespace desktop_probe
#endif
