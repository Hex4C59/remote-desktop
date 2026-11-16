#ifndef REMOTE_DESKTOP_LINUX_DESKTOP_SOURCE_H_
#define REMOTE_DESKTOP_LINUX_DESKTOP_SOURCE_H_
#include "remote_desktop_probe/frame_source.h"
namespace desktop_probe {
std::unique_ptr<FrameSource> CreateX11DesktopSource();
}
#endif
