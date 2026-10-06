#ifndef REMOTE_DESKTOP_PROBE_SOFTWARE_TRACE_H_
#define REMOTE_DESKTOP_PROBE_SOFTWARE_TRACE_H_

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <fstream>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

namespace desktop_probe {
struct CaptureTiming {
  std::string outcome = "failed";
  std::string acquire_status = "not_applicable";
  uint64_t frame_id = 0;
  int source_width = 0, source_height = 0;
  std::optional<uint64_t> capture_ns, acquire_ns, readback_ns, convert_ns;
  std::optional<uint64_t> rotate_ns, scale_ns, submit_ns, total_ns;
};
// No clock reads when observation is disabled. Capturing remains thread-owned.
class TimedStage {
 public:
  explicit TimedStage(std::optional<uint64_t>* result) : result_(result) {
    if (result_) started_ = std::chrono::steady_clock::now();
  }
  ~TimedStage() { Stop(); }
  void Stop() {
    if (!result_) return;
    *result_ = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - started_).count());
    result_ = nullptr;
  }
 private:
  std::optional<uint64_t>* result_;
  std::chrono::steady_clock::time_point started_;
};
// The bounded writer never performs file IO on the capture/signaling threads.
class SoftwareTrace {
 public:
  explicit SoftwareTrace(const std::string& directory);
  ~SoftwareTrace();
  bool valid() const { return file_.is_open(); }
  void SetReceiverSample(std::string session, uint64_t sequence);
  void Record(const CaptureTiming& timing, int width, int height);
 private:
  void Write();
  std::ofstream file_;
  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<std::string> pending_;
  std::thread writer_;
  std::string session_;
  uint64_t sequence_ = 0, dropped_ = 0, receiver_sequence_ = 0;
  bool stopping_ = false;
};
}
#endif
