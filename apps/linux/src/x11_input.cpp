#include "remote_desktop_probe/x11_input.h"
#include "remote_desktop_probe/input_protocol.h"
#include <X11/XKBlib.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>

namespace desktop_probe {
X11Input::X11Input(DesktopBounds bounds) {
  display_ = XOpenDisplay(nullptr);
  if (!display_) return;
  int event = 0, error = 0, major = 0, minor = 0;
  if (!XTestQueryExtension(display_, &event, &error, &major, &minor)) return;
  auto selected = PrimaryMonitor(display_);
  if (selected && selected->bounds.left == bounds.left && selected->bounds.top == bounds.top &&
      selected->bounds.width == bounds.width && selected->bounds.height == bounds.height)
    monitor_ = selected;
}
X11Input::~X11Input() {
  if (display_) {
    if (!Release()) std::cerr << "input_release_failed=true\n";
    XCloseDisplay(display_);
  }
}
bool X11Input::Press(KeyCode code) {
  if (!code || !XTestFakeKeyEvent(display_, code, True, CurrentTime)) return false;
  held_.push_back(code);
  return true;
}
bool X11Input::ReleaseKey(KeyCode code) {
  if (!XTestFakeKeyEvent(display_, code, False, CurrentTime)) return false;
  auto found = std::find(held_.begin(), held_.end(), code);
  if (found != held_.end()) held_.erase(found);
  return true;
}
bool X11Input::Release() {
  bool success = true;
  while (!held_.empty()) {
    if (!ReleaseKey(held_.back())) { success = false; break; }
  }
  if (button_held_) {
    if (XTestFakeButtonEvent(display_, 1, False, CurrentTime)) button_held_ = false;
    else success = false;
  }
  XSync(display_, False);
  return success;
}
std::optional<X11Input::KeyStroke> X11Input::FindSymbol(KeySym symbol,
                                                     unsigned int locked, int group) {
  int first = 0, last = 0;
  XDisplayKeycodes(display_, &first, &last);
  const unsigned int level3_mask = XkbKeysymToModifiers(display_, XK_ISO_Level3_Shift);
  const KeyCode level3_code = XKeysymToKeycode(display_, XK_ISO_Level3_Shift);
  for (bool level3 : {false, true}) {
    if (level3 && (!level3_mask || !level3_code)) continue;
    for (bool shift : {false, true}) {
      for (int code = first; code <= last; ++code) {
        KeySym translated = NoSymbol;
        unsigned int consumed = 0;
        const unsigned int modifiers = locked | (shift ? ShiftMask : 0) |
                                       (level3 ? level3_mask : 0);
        if (XkbLookupKeySym(display_, static_cast<KeyCode>(code),
              XkbBuildCoreState(modifiers, group), &consumed, &translated) &&
            translated == symbol) return KeyStroke{static_cast<KeyCode>(code), shift, level3};
      }
    }
  }
  return std::nullopt;
}
bool X11Input::Execute(std::string_view message) {
  const auto command = ParseInput(message);
  if (!command || !valid() || PrimaryMonitor(display_) != monitor_ || !Release()) return false;
  XkbStateRec state{};
  if (XkbGetState(display_, XkbUseCoreKbd, &state) != Success) return false;
  // Refuse to combine remote input with keys physically held on this computer.
  // Caps/Num lock are incorporated when translating text; no layout is changed.
  std::array<char, 32> pressed{};
  XQueryKeymap(display_, pressed.data());
  for (char bits : pressed) { if (bits != 0) return false; }
  const unsigned int lock_modifiers = XkbKeysymToModifiers(display_, XK_Caps_Lock) |
                                      XkbKeysymToModifiers(display_, XK_Num_Lock);
  if (state.latched_mods || (state.locked_mods & ~lock_modifiers)) return false;
  Window root = 0, child = 0;
  int root_x = 0, root_y = 0, window_x = 0, window_y = 0;
  unsigned int pointer_state = 0;
  if (!XQueryPointer(display_, XDefaultRootWindow(display_), &root, &child, &root_x,
                     &root_y, &window_x, &window_y, &pointer_state) ||
      (pointer_state & (Button1Mask | Button2Mask | Button3Mask | Button4Mask | Button5Mask)))
    return false;
  const KeyCode shift = XKeysymToKeycode(display_, XK_Shift_L);
  const KeyCode control = XKeysymToKeycode(display_, XK_Control_L);
  const KeyCode level3 = XKeysymToKeycode(display_, XK_ISO_Level3_Shift);
  auto stroke = [&](const KeyStroke& key, bool ctrl) {
    return (!ctrl || (control && Press(control))) &&
           (!key.shift || (shift && Press(shift))) &&
           (!key.level3 || (level3 && Press(level3))) &&
           Press(key.code) && ReleaseKey(key.code) &&
           (!key.level3 || ReleaseKey(level3)) && (!key.shift || ReleaseKey(shift)) &&
           (!ctrl || ReleaseKey(control));
  };
  bool success = false;
  using Kind = InputCommand::Kind;
  if (command->kind == Kind::Click) {
    const auto& bounds = monitor_->bounds;
    const int x = bounds.left + static_cast<int>((int64_t{command->x} * (bounds.width - 1) + 32767) / 65535);
    const int y = bounds.top + static_cast<int>((int64_t{command->y} * (bounds.height - 1) + 32767) / 65535);
    success = XTestFakeMotionEvent(display_, XDefaultScreen(display_), x, y, CurrentTime);
    if (success) {
      button_held_ = XTestFakeButtonEvent(display_, 1, True, CurrentTime);
      success = button_held_ && XTestFakeButtonEvent(display_, 1, False, CurrentTime);
      if (success) button_held_ = false;
    }
  } else if (command->kind == Kind::Text) {
    std::vector<KeyStroke> strokes;
    for (unsigned char character : command->text) {
      auto key = FindSymbol(character, state.locked_mods, state.group);
      if (!key || (key->shift && !shift) || (key->level3 && !level3)) return false;
      strokes.push_back(*key);
    }
    success = true;
    for (const auto& key : strokes) {
      if (!stroke(key, false)) {
        success = false; break;
      }
    }
  } else if (command->kind == Kind::CtrlC) {
    auto c = FindSymbol(XK_c, 0, state.group);
    success = c && stroke(*c, true);
  } else {
    KeySym symbol = NoSymbol;
    switch (command->kind) {
      case Kind::Enter: symbol = XK_Return; break;
      case Kind::Tab: symbol = XK_Tab; break;
      case Kind::Left: symbol = XK_Left; break;
      case Kind::Right: symbol = XK_Right; break;
      case Kind::Up: symbol = XK_Up; break;
      case Kind::Down: symbol = XK_Down; break;
      case Kind::Backspace: symbol = XK_BackSpace; break;
      default: return false;
    }
    auto key = FindSymbol(symbol, state.locked_mods, state.group);
    success = key && stroke(*key, false);
  }
  if (!Release()) success = false;
  if (success) std::cout << "input_executed=true\n";
  else std::cerr << "input_injection_failed=true\n";
  return success;
}
}  // namespace desktop_probe
