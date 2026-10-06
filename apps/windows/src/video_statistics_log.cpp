#include "remote_desktop_probe/video_statistics_log.h"

#include <algorithm>
#include <iostream>
#include <sstream>

#include "third_party/jsoncpp/source/include/json/json.h"

namespace desktop_probe {
VideoStatisticsLog::VideoStatisticsLog() {
  const auto stamp = std::chrono::duration_cast<std::chrono::microseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string path = "receiver-statistics-" + std::to_string(stamp) + ".jsonl";
  file_.open(path, std::ios::binary | std::ios::out);
  if (!file_) { std::cerr << "statistics_file_unavailable=true" << std::endl; return; }
  file_ << "{\"event\":\"sender_started\",\"schema\":1,"
        << "\"scope\":\"delivered_receiver_samples_only\","
        << "\"target_max_fps\":30,\"target_max_bitrate_bps\":4000000}\n";
  file_.flush();
  std::cout << "statistics_file=" << path << std::endl;
}

VideoStatisticsLog::~VideoStatisticsLog() {
  std::lock_guard lock(mutex_);
  Json::Value record;
  record["event"] = "sender_stopped";
  record["session"] = session_;
  record["last_saved_seq"] = Json::UInt64(sequence_);
  record["receiver_end_observed"] = false;
  Json::StreamWriterBuilder writer;
  writer["indentation"] = "";
  file_ << Json::writeString(writer, record) << '\n';
  file_.flush();
}

std::optional<VideoStatisticsLog::SavedSample> VideoStatisticsLog::Record(const std::string& payload) {
  std::lock_guard lock(mutex_);
  const auto now = Clock::now();
  if (!file_ || payload.size() > 8192 || written_ >= 16 * 1024 * 1024 ||
      (sequence_ && now - last_record_ < std::chrono::milliseconds(200))) return std::nullopt;
  Json::CharReaderBuilder reader;
  reader["collectComments"] = false;
  reader["failIfExtra"] = true;
  reader["rejectDupKeys"] = true;
  reader["stackLimit"] = 16;
  Json::Value sample;
  std::string errors;
  std::istringstream input(payload);
  if (!Json::parseFromStream(reader, input, &sample, &errors) || !sample.isObject() ||
      sample["schema"] != 1 || !sample["session"].isString() || !sample["seq"].isUInt64() ||
      !sample["state"].isString() || !sample["raw"].isObject() || !sample["ui"].isString()) return std::nullopt;
  const std::string session = sample["session"].asString();
  if (session.size() != 36 || !std::all_of(session.begin(), session.end(), [](char ch) {
        return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || ch == '-';
      }) || (!session_.empty() && session != session_)) return std::nullopt;
  const auto sequence = sample["seq"].asUInt64();
  if (!sequence || sequence <= sequence_) return std::nullopt;
  Json::Value record;
  record["event"] = "receiver_sample";
  record["sender_elapsed_ms"] = Json::Int64(
      std::chrono::duration_cast<std::chrono::milliseconds>(now - started_).count());
  record["missing_sequences_before"] = Json::UInt64(sequence - sequence_ - 1);
  record["sample"] = std::move(sample);
  Json::StreamWriterBuilder writer;
  writer["indentation"] = "";
  const std::string line = Json::writeString(writer, record);
  file_ << line << '\n';
  file_.flush();
  if (!file_) { std::cerr << "statistics_write_failed=true" << std::endl; return std::nullopt; }
  written_ += line.size() + 1;
  sequence_ = sequence;
  session_ = session;
  last_record_ = now;
  return SavedSample{session, sequence, "stats-saved:" + session + ":" + std::to_string(sequence)};
}
}
