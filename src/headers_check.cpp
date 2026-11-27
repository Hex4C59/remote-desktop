// 职责：把 include/ 下的公共头文件都包含一遍，让它们参与真实编译。
// Thread: none
//
// 这个文件不实现任何功能。它的唯一作用是在构建时验证公共头文件能独立编译
// （不依赖包含顺序、不缺 include）。新增公共头文件时在此追加一行。

#include <remotedesktop/assert.h>
#include <remotedesktop/frame_handoff.h>
#include <remotedesktop/platform/platform.h>
#include <remotedesktop/platform/win/desktop_state_reader.h>
#include <remotedesktop/platform/win/input_inject_win.h>
#include <remotedesktop/platform/win/screen_capture_win.h>
#include <remotedesktop/version.h>
