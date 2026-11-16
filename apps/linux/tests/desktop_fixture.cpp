#include "remote_desktop_probe/desktop_source.h"
#include <X11/Xlib.h>
#include <iostream>

int main() {
  Display* display = XOpenDisplay(nullptr);
  if (!display) return 1;
  Window window = XCreateSimpleWindow(display, XDefaultRootWindow(display), 0, 0, 100, 100, 0, 0, 0);
  XMapWindow(display, window); XSync(display, False);
  auto source = desktop_probe::CreateX11DesktopSource();
  if (!source->Initialize() || !source->InputBounds()) return 1;
  webrtc::scoped_refptr<webrtc::I420Buffer> first, second;
  if (!source->Capture(first, nullptr) || !first || first->width() > 1280 || first->height() > 720 ||
      first->width() % 2 || first->height() % 2) return 1;
  const unsigned char before = *first->DataY();
  XSetWindowBackground(display, window, XWhitePixel(display, XDefaultScreen(display)));
  XClearWindow(display, window); XSync(display, False);
  if (!source->Capture(second, nullptr) || !second || *second->DataY() == before) return 1;
  source.reset(); XDestroyWindow(display, window); XCloseDisplay(display);
  std::cout << "desktop_fixture_passed=true dynamic_pixels=true immutable_previous="
            << (*first->DataY() == before) << '\n';
  return *first->DataY() == before ? 0 : 1;
}
