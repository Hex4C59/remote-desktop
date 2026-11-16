// Independent X11 event observer; runs only on a private synthetic test display.
#include "remote_desktop_probe/x11_input.h"
#include "remote_desktop_probe/input_protocol.h"
#include <X11/XKBlib.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <array>
#include <chrono>
#include <iostream>
#include <map>
#include <cstdlib>
#include <thread>
#include <vector>
#include <tuple>

namespace {
int fail_key_in = -1, fail_button_in = -1;
void Require(bool condition, const char* reason) {
  if (!condition) { std::cerr << "input_fixture_failed=" << reason << '\n'; std::exit(1); }
}
}
extern "C" int __real_XTestFakeKeyEvent(Display*, unsigned int, Bool, unsigned long);
extern "C" int __wrap_XTestFakeKeyEvent(Display* display, unsigned int code, Bool press, unsigned long delay) {
  if (fail_key_in == 0) { fail_key_in = -1; return 0; }
  if (fail_key_in > 0) --fail_key_in;
  return __real_XTestFakeKeyEvent(display, code, press, delay);
}
extern "C" int __real_XTestFakeButtonEvent(Display*, unsigned int, Bool, unsigned long);
extern "C" int __wrap_XTestFakeButtonEvent(Display* display, unsigned int button, Bool press, unsigned long delay) {
  if (fail_button_in == 0) { fail_button_in = -1; return 0; }
  if (fail_button_in > 0) --fail_button_in;
  return __real_XTestFakeButtonEvent(display, button, press, delay);
}
namespace {
std::vector<XEvent> Events(Display* display) {
  XSync(display, False);
  std::vector<XEvent> result;
  while (XPending(display)) {
    XEvent event{}; XNextEvent(display, &event);
    if (event.type == KeyPress || event.type == KeyRelease ||
        event.type == ButtonPress || event.type == ButtonRelease) result.push_back(event);
  }
  return result;
}
std::string Text(std::vector<XEvent> events) {
  std::string text;
  for (auto& event : events) {
    if (event.type != KeyPress) continue;
    std::array<char, 16> bytes{};
    KeySym symbol = NoSymbol;
    const int count = XLookupString(&event.xkey, bytes.data(), static_cast<int>(bytes.size()), &symbol, nullptr);
    Require(count >= 0 && count <= static_cast<int>(bytes.size()), "lookup bounds");
    text.append(bytes.data(), static_cast<size_t>(count));
  }
  return text;
}
void Balanced(Display* display, const std::vector<XEvent>& events) {
  std::map<unsigned int, int> held;
  for (const auto& event : events) {
    if (event.type == KeyPress) ++held[event.xkey.keycode];
    if (event.type == KeyRelease) --held[event.xkey.keycode];
    if (event.type == ButtonPress) ++held[256 + event.xbutton.button];
    if (event.type == ButtonRelease) --held[256 + event.xbutton.button];
  }
  for (const auto& [code, count] : held) { Require(count == 0, "unpaired event"); (void)code; }
  std::array<char, 32> keys{}; XQueryKeymap(display, keys.data());
  for (char bits : keys) Require(bits == 0, "stuck key");
  Window root = 0, child = 0;
  int root_x = 0, root_y = 0, x = 0, y = 0;
  unsigned int mask = 0;
  Require(XQueryPointer(display, XDefaultRootWindow(display), &root, &child,
                        &root_x, &root_y, &x, &y, &mask), "pointer query");
  Require(!(mask & (Button1Mask | ControlMask | ShiftMask)), "stuck button/modifier");
}
void Run() {
  Display* display = XOpenDisplay(nullptr);
  Require(display != nullptr, "display unavailable");
  auto monitor = desktop_probe::PrimaryMonitor(display);
  Require(monitor.has_value(), "monitor unavailable");
  const Window window = XCreateSimpleWindow(display, XDefaultRootWindow(display), 0, 0,
      static_cast<unsigned int>(monitor->bounds.width), static_cast<unsigned int>(monitor->bounds.height),
      0, 0, 0);
  XSelectInput(display, window, KeyPressMask | KeyReleaseMask | ButtonPressMask | ButtonReleaseMask);
  XMapWindow(display, window); XSetInputFocus(display, window, RevertToParent, CurrentTime);
  XSync(display, False); Events(display);
  {
    desktop_probe::X11Input input(monitor->bounds);
    Require(input.valid(), "input unavailable");
    for (std::string invalid : {"pointer:click:-1:0", "pointer:click:65536:0", "pointer:click:0:0:1",
          "pointer:click:1:2junk", "pointer:click::2", "pointer:click:1:2\n", "text:",
          "text:ok\n", "text:中文", "key:escape", "key:enter:extra"}) {
      Require(!input.Execute(invalid), "invalid accepted");
      Require(Events(display).empty(), "invalid input caused events");
    }
    Require(!input.Execute("text:" + std::string(257, 'a')), "oversized text accepted");
    Require(Events(display).empty(), "oversized text caused events");
    std::string ascii;
    for (int character = 0x20; character <= 0x7e; ++character) ascii += static_cast<char>(character);
    Require(input.Execute("text:" + ascii), "ASCII failed");
    auto events = Events(display); Require(Text(events) == ascii, "ASCII mismatch"); Balanced(display, events);
    XkbLockModifiers(display, XkbUseCoreKbd, LockMask, LockMask); XSync(display, False);
    Require(input.Execute("text:" + ascii), "Caps ASCII failed");
    events = Events(display); Require(Text(events) == ascii, "Caps ASCII mismatch"); Balanced(display, events);
    XkbLockModifiers(display, XkbUseCoreKbd, LockMask, 0); XSync(display, False);
    for (const auto& [wire, symbol] : {std::pair{"key:enter", XK_Return}, {"key:tab", XK_Tab},
        {"key:left", XK_Left}, {"key:right", XK_Right}, {"key:up", XK_Up}, {"key:down", XK_Down},
        {"key:backspace", XK_BackSpace}}) {
      Require(input.Execute(wire), "function key failed"); events = Events(display);
      Require(events.size() == 2 && events.front().type == KeyPress &&
          XLookupKeysym(&events.front().xkey, 0) == static_cast<KeySym>(symbol), "function key mismatch");
      Balanced(display, events);
    }
    Require(input.Execute("key:ctrl+c"), "Ctrl+C failed"); events = Events(display);
    Require(Text(events) == std::string(1, '\x03'), "Ctrl+C mismatch"); Balanced(display, events);
    for (const auto& [wire, expected_x, expected_y] : {
        std::tuple{"pointer:click:0:0", 0, 0}, {"pointer:click:65535:65535", monitor->bounds.width - 1, monitor->bounds.height - 1}}) {
      Require(input.Execute(wire), "click failed"); events = Events(display);
      Require(events.size() == 2 && events.front().type == ButtonPress &&
          events.front().xbutton.x == expected_x && events.front().xbutton.y == expected_y, "click mismatch");
      Balanced(display, events);
    }
    const auto local_control = XKeysymToKeycode(display, XK_Control_L);
    Require(__real_XTestFakeKeyEvent(display, local_control, True, CurrentTime), "local key setup");
    auto local_events = Events(display);
    Require(!input.Execute("text:a") && Events(display).empty(), "local key overwritten");
    Require(__real_XTestFakeKeyEvent(display, local_control, False, CurrentTime), "local key cleanup");
    auto released = Events(display); local_events.insert(local_events.end(), released.begin(), released.end());
    Balanced(display, local_events);
    Require(__real_XTestFakeButtonEvent(display, 1, True, CurrentTime), "local button setup");
    local_events = Events(display);
    Require(!input.Execute("pointer:click:0:0") && Events(display).empty(), "local button overwritten");
    Require(__real_XTestFakeButtonEvent(display, 1, False, CurrentTime), "local button cleanup");
    released = Events(display); local_events.insert(local_events.end(), released.begin(), released.end());
    Balanced(display, local_events);
    fail_key_in = 1;
    Require(!input.Execute("key:ctrl+c"), "key fault ignored"); Balanced(display, Events(display));
    fail_button_in = 1;
    Require(!input.Execute("pointer:click:0:0"), "button fault ignored"); Balanced(display, Events(display));
  }
  XDestroyWindow(display, window); XCloseDisplay(display);
  std::cout << "input_fixture_passed=true invalid_cases=12 printable_ascii=95 caps_lock=true function_keys=8 click_edges=2 partial_failure_cleanup=2 local_input_guards=2\n";
}
}
int main() { Run(); return 0; }
