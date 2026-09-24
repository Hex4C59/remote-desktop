#include "remote_desktop_probe/keyboard_input.h"

#include <iostream>
#include <span>
#include <vector>

namespace desktop_probe {
namespace {
INPUT Key(WORD code, DWORD flags = 0) {
  INPUT event{};
  event.type = INPUT_KEYBOARD;
  event.ki.wVk = code;
  event.ki.dwFlags = flags;
  return event;
}
}  // namespace

KeyboardInput::~KeyboardInput() {
  if (!Release()) std::cerr << "keyboard_release_failed=true" << std::endl;
}

bool KeyboardInput::Release() {
  while (held_ > 0) {
    if (SendInput(1, &releases_[held_ - 1], sizeof(INPUT)) != 1) return false;
    --held_;
  }
  return true;
}

bool KeyboardInput::Execute(std::string_view message) {
  std::vector<INPUT> events;
  if (message.starts_with("text:")) {
    message.remove_prefix(5);
    if (message.empty() || message.size() > 256) return false;
    for (unsigned char character : message) {
      if (character < 0x20 || character > 0x7e) return false;
    }
    events.reserve(message.size() * 2);
    for (unsigned char character : message) {
      INPUT event = Key(0, KEYEVENTF_UNICODE);
      event.ki.wScan = character;
      events.push_back(event);
      event.ki.dwFlags |= KEYEVENTF_KEYUP;
      events.push_back(event);
    }
  } else if (message == "key:ctrl+c") {
    events = {Key(VK_LCONTROL), Key('C'), Key('C', KEYEVENTF_KEYUP),
              Key(VK_LCONTROL, KEYEVENTF_KEYUP)};
  } else {
    WORD code = 0;
    DWORD flags = 0;
    if (message == "key:enter") code = VK_RETURN;
    else if (message == "key:tab") code = VK_TAB;
    else if (message == "key:backspace") code = VK_BACK;
    else {
      flags = KEYEVENTF_EXTENDEDKEY;
      if (message == "key:left") code = VK_LEFT;
      else if (message == "key:right") code = VK_RIGHT;
      else if (message == "key:up") code = VK_UP;
      else if (message == "key:down") code = VK_DOWN;
      else return false;
    }
    events = {Key(code, flags), Key(code, flags | KEYEVENTF_KEYUP)};
  }
  if (!Release()) return false;
  const UINT sent = SendInput(static_cast<UINT>(events.size()), events.data(), sizeof(INPUT));
  // Account only for inserted events. Successful UPs release ownership; after
  // a short write, unwind still-held keys in reverse order (C, then Ctrl).
  for (const INPUT& event : std::span(events).first(sent)) {
    if (event.ki.dwFlags & KEYEVENTF_KEYUP) {
      --held_;
    } else {
      INPUT release = event;
      release.ki.dwFlags |= KEYEVENTF_KEYUP;
      releases_[held_++] = release;
    }
  }
  if (sent != events.size()) {
    Release();
    std::cerr << "keyboard_injection_failed=true events=" << sent << std::endl;
    return false;
  }
  // Deliberately never log user text or reconstruct terminal commands here.
  std::cout << "keyboard_input=true events=" << sent << std::endl;
  return true;
}
}  // namespace desktop_probe
