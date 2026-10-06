#include "remote_desktop_probe/software_trace.h"
#include <span>
#include <string>

int main(int argc, char** argv) {
  if (argc != 2) return 2;
#pragma clang unsafe_buffer_usage begin
  const std::span<char*> arguments(argv, static_cast<size_t>(argc));
#pragma clang unsafe_buffer_usage end
  desktop_probe::SoftwareTrace trace{std::string(arguments[1])};
  if (!trace.valid()) return 1;
  trace.SetReceiverSample("00000000-0000-0000-0000-000000000001", 1);
  for (int i = 0; i < 1000; ++i) {
    desktop_probe::CaptureTiming timing;
    timing.outcome = i % 2 ? "reused" : "fresh";
    timing.acquire_status = i % 2 ? "timeout" : "acquired";
    timing.frame_id = static_cast<uint64_t>(i / 2 + 1);
    { desktop_probe::TimedStage stage(&timing.capture_ns); }
    if (!timing.capture_ns) return 1;
    trace.Record(timing, 1280, 720);
  }
  return 0;
}
