#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <stdexcept>

namespace impairment {
enum class Mode { Pass, Rate, Delay, Loss };
enum class Result { Queued, RandomDrop, QueueDrop };
struct Decision { Result result; std::int64_t due_ns; };
// Each direction owns a scheduler. Time is supplied by the adapter, never wall time.
class Scheduler {
 public:
  explicit Scheduler(unsigned direction) : direction_(direction) { Reset(Mode::Pass); }
  void Reset(Mode mode) {
    mode_ = mode; next_ns_ = 0; bytes_ = 0;
    random_ = 20261013ULL ^ (direction_ ? 0x9e3779b97f4a7c15ULL : 0ULL);
  }
  Decision Enqueue(std::int64_t now, std::size_t bytes) {
    if (!bytes || bytes > 65535) throw std::invalid_argument("Invalid IP packet size");
    if (mode_ == Mode::Loss && (NextRandom() >> 11) < 90071992547409ULL)
      return {Result::RandomDrop, now};
    std::int64_t due = now;
    if (mode_ == Mode::Rate)
      due = std::max(now, next_ns_) + static_cast<std::int64_t>((bytes * 8000000000ULL + 116092) / 116093);
    if (mode_ == Mode::Delay) due = std::max(now + 50000000LL, next_ns_);
    if (bytes_ + bytes > 1024 * 1024 || due - now > 2000000000LL)
      return {Result::QueueDrop, due};
    bytes_ += bytes; next_ns_ = due;
    return {Result::Queued, due};
  }
  void Complete(std::size_t bytes) {
    if (bytes > bytes_) throw std::logic_error("Queue accounting underflow");
    bytes_ -= bytes;
  }
  std::size_t queued_bytes() const { return bytes_; }
 private:
  std::uint64_t NextRandom() {
    random_ ^= random_ >> 12; random_ ^= random_ << 25; random_ ^= random_ >> 27;
    return random_ * 2685821657736338717ULL;
  }
  unsigned direction_;
  Mode mode_;
  std::int64_t next_ns_{};
  std::size_t bytes_{};
  std::uint64_t random_{};
};
}
