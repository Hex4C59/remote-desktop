#ifndef REMOTE_DESKTOP_PROBE_KEYBOARD_INPUT_H_
#define REMOTE_DESKTOP_PROBE_KEYBOARD_INPUT_H_

#include <windows.h>

#include <array>
#include <string_view>

namespace desktop_probe {
// Capture-thread owned. Messages are complete text/key actions, never a key
// held across network messages. Only partially inserted batches need cleanup.
class KeyboardInput {
 public:
  KeyboardInput() = default;
  ~KeyboardInput();
  KeyboardInput(const KeyboardInput&) = delete;
  KeyboardInput& operator=(const KeyboardInput&) = delete;
  bool Execute(std::string_view message);

 private:
  bool Release();
  // At most Ctrl and C can be down together. Text uses adjacent DOWN/UP pairs.
  std::array<INPUT, 2> releases_{};
  size_t held_ = 0;
};
}  // namespace desktop_probe
#endif
