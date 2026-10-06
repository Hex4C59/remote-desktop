#include "remote_desktop_probe/software_trace.h"

#include <filesystem>
#include <iostream>
#include <system_error>
#include "third_party/jsoncpp/source/include/json/json.h"

namespace desktop_probe {
namespace {
std::string Line(const Json::Value& record) {
  Json::StreamWriterBuilder writer;
  writer["indentation"] = "";
  return Json::writeString(writer, record) + '\n';
}
}
SoftwareTrace::SoftwareTrace(const std::string& directory) {
  std::error_code error;
  std::filesystem::create_directories(directory, error);
  const auto path = std::filesystem::path(directory) / "stages.jsonl";
  if (error || std::filesystem::exists(path, error) || error) return;
  file_.open(path, std::ios::binary);
  if (!file_) return;
  file_ << "{\"schema\":\"software-stages-v1\",\"event\":\"started\","
           "\"clock\":\"steady_clock\",\"submit_endpoint\":\"Push_return\"}\n";
  writer_ = std::thread([this] { Write(); });
}
SoftwareTrace::~SoftwareTrace() {
  { std::lock_guard lock(mutex_); stopping_ = true; }
  ready_.notify_one();
  if (writer_.joinable()) writer_.join();
}
void SoftwareTrace::SetReceiverSample(std::string session, uint64_t sequence) {
  std::lock_guard lock(mutex_);
  if (session_.empty()) session_ = std::move(session);
  receiver_sequence_ = sequence;
}
void SoftwareTrace::Record(const CaptureTiming& timing, int width, int height) {
  std::lock_guard lock(mutex_);
  ++sequence_;
  if (pending_.size() >= 128) { ++dropped_; return; }
  Json::Value row;
  row["schema"] = "software-stages-v1";
  row["event"] = "capture";
  row["seq"] = Json::UInt64(sequence_);
  row["session"] = session_.empty() ? Json::Value() : Json::Value(session_);
  row["receiver_statistics_seq"] = Json::UInt64(receiver_sequence_);
  row["observed_ns"] = std::to_string(std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
  row["outcome"] = timing.outcome;
  row["acquire_status"] = timing.acquire_status;
  row["frame_id"] = Json::UInt64(timing.frame_id);
  row["width"] = width;
  row["height"] = height;
  row["source_width"] = timing.source_width;
  row["source_height"] = timing.source_height;
  row["dropped_records_total"] = Json::UInt64(dropped_);
  for (const auto& field : {std::pair{"capture_ns", timing.capture_ns},
       {"acquire_ns", timing.acquire_ns}, {"readback_ns", timing.readback_ns},
       {"convert_ns", timing.convert_ns}, {"rotate_ns", timing.rotate_ns},
       {"scale_ns", timing.scale_ns}, {"submit_ns", timing.submit_ns},
       {"total_ns", timing.total_ns}}) {
    row[field.first] = field.second ? Json::Value(std::to_string(*field.second)) : Json::Value();
  }
  pending_.push_back(Line(row));
  ready_.notify_one();
}
void SoftwareTrace::Write() {
  size_t written = 0;
  bool write_failed = false;
  for (;;) {
    std::string line;
    { std::unique_lock lock(mutex_);
      ready_.wait(lock, [this] { return stopping_ || !pending_.empty(); });
      if (pending_.empty()) break;
      line = std::move(pending_.front()); pending_.pop_front();
    }
    if (!write_failed && written + line.size() <= 32 * 1024 * 1024) {
      file_ << line;
      written += line.size();
      write_failed = !file_;
    } else {
      write_failed = true;
      std::lock_guard lock(mutex_); ++dropped_;
    }
  }
  Json::Value end;
  end["schema"] = "software-stages-v1"; end["event"] = "stopped";
  end["session"] = session_; end["records_attempted"] = Json::UInt64(sequence_);
  end["dropped_records_total"] = Json::UInt64(dropped_);
  end["write_failed"] = write_failed;
  file_ << Line(end);
  file_.flush();
  if (!file_ || write_failed) std::cerr << "software_trace_write_failed=true\n";
}
}
