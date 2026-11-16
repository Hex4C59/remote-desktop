#ifndef REMOTE_DESKTOP_LINUX_INPUT_PROTOCOL_H_
#define REMOTE_DESKTOP_LINUX_INPUT_PROTOCOL_H_

#include <charconv>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

namespace desktop_probe {
struct InputCommand {
  enum class Kind { Click, Text, Enter, Tab, Left, Right, Up, Down, Backspace, CtrlC };
  Kind kind;
  int x = 0, y = 0;
  std::string text = {};
};

inline std::optional<InputCommand> ParseInput(std::string_view message) {
  using Kind = InputCommand::Kind;
  if (message.starts_with("pointer:click:")) {
    message.remove_prefix(14);
    const auto separator = message.find(':');
    if (separator == std::string_view::npos) return std::nullopt;
    InputCommand command{Kind::Click};
    auto coordinate = [](std::string_view value, int& result) {
      if (value.empty() || value.size() > 5) return false;
      auto parsed = std::from_chars(value.data(), value.substr(value.size()).data(), result);
      return parsed.ec == std::errc() && parsed.ptr == value.substr(value.size()).data() &&
             result >= 0 && result <= 65535;
    };
    if (!coordinate(message.substr(0, separator), command.x) ||
        !coordinate(message.substr(separator + 1), command.y)) return std::nullopt;
    return command;
  }
  if (message.starts_with("text:")) {
    message.remove_prefix(5);
    if (message.empty() || message.size() > 256) return std::nullopt;
    for (unsigned char character : message) {
      if (character < 0x20 || character > 0x7e) return std::nullopt;
    }
    return InputCommand{Kind::Text, 0, 0, std::string(message)};
  }
  for (const auto& [wire, kind] : {
      std::pair{"key:enter", Kind::Enter}, {"key:tab", Kind::Tab},
      {"key:left", Kind::Left}, {"key:right", Kind::Right},
      {"key:up", Kind::Up}, {"key:down", Kind::Down},
      {"key:backspace", Kind::Backspace}, {"key:ctrl+c", Kind::CtrlC}}) {
    if (message == wire) return InputCommand{kind};
  }
  return std::nullopt;
}
}  // namespace desktop_probe
#endif
