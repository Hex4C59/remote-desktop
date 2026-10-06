#ifndef REMOTE_DESKTOP_PROBE_VIDEO_STATISTICS_LOG_H_
#define REMOTE_DESKTOP_PROBE_VIDEO_STATISTICS_LOG_H_

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <fstream>
#include <mutex>
#include <optional>
#include <string>

namespace desktop_probe {
// Stores bounded, authenticated receiver samples separately from input. A receipt
// means the record was flushed, not that its decoded frames reached a display.
class VideoStatisticsLog {
 public:
  VideoStatisticsLog();
  ~VideoStatisticsLog();
  struct SavedSample {
    std::string session;
    uint64_t sequence;
    std::string receipt;
  };
  std::optional<SavedSample> Record(const std::string& payload);
 private:
  using Clock = std::chrono::steady_clock;
  std::mutex mutex_;
  std::ofstream file_;
  const Clock::time_point started_ = Clock::now();
  Clock::time_point last_record_ = Clock::time_point::min();
  std::string session_;
  uint64_t sequence_ = 0;
  size_t written_ = 0;
};
}
#endif
