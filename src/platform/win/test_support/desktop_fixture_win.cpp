// Owns the test window and restores the display settings used by the test.
// Thread: ui only
#include "desktop_fixture_win.h"

#include <array>
#include <cstdint>

#include <windows.h>

#include <psapi.h>
#include <shellscalingapi.h>
#include <windowsx.h>

namespace rd::platform::win::test {
  namespace {
    constexpr wchar_t kWindowClass[] = L"RemoteDesktop.AcceptanceWindow";
    constexpr DWORD kModeFields =
        DM_PELSWIDTH | DM_PELSHEIGHT | DM_BITSPERPEL | DM_DISPLAYFREQUENCY;

    DEVMODEW empty_mode() noexcept {
      DEVMODEW mode{};
      mode.dmSize = sizeof(mode);
      return mode;
    }

    bool read_mode(DWORD index, DEVMODEW& mode) noexcept {
      mode = empty_mode();
      return EnumDisplaySettingsW(nullptr, index, &mode) != FALSE;
    }

    bool key_down(int virtual_key) noexcept {
      return (static_cast<unsigned short>(GetAsyncKeyState(virtual_key)) &
              0x8000) != 0;
    }
  }  // namespace

  DesktopAcceptanceLock::DesktopAcceptanceLock() noexcept {
    const auto mutex = CreateMutexW(
        nullptr, FALSE, L"Local\\RemoteDesktop.WindowsDesktopAcceptance");
    if (mutex == nullptr) {
      return;
    }
    const auto status = WaitForSingleObject(mutex, 0);
    if (status == WAIT_OBJECT_0 || status == WAIT_ABANDONED) {
      mutex_ = mutex;
    } else {
      CloseHandle(mutex);
    }
  }

  DesktopAcceptanceLock::~DesktopAcceptanceLock() {
    if (mutex_ != nullptr) {
      ReleaseMutex(mutex_);
      CloseHandle(mutex_);
    }
  }

  bool DesktopAcceptanceLock::acquired() const noexcept {
    return mutex_ != nullptr;
  }

  struct DesktopWindow::Window {
    HINSTANCE instance{GetModuleHandleW(nullptr)};
    HWND hwnd{};
    bool registered{};
    WindowUse use;
    WindowInput input;
    COLORREF color{RGB(0x22, 0x50, 0xac)};

    Window(const wchar_t* title, WindowUse window_use) : use(window_use) {
      WNDCLASSW definition{};
      definition.lpfnWndProc = &on_message;
      definition.hInstance = instance;
      definition.lpszClassName = kWindowClass;
      registered = RegisterClassW(&definition) != 0;
      if (registered) {
        const auto style = static_cast<DWORD>(
            WS_EX_TOPMOST |
            (use == WindowUse::kInput ? WS_EX_APPWINDOW
                                      : WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW));
        hwnd = CreateWindowExW(style, kWindowClass, title,
                               WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, 100,
                               100, 520, 240, nullptr, nullptr, instance, this);
      }
      if (hwnd != nullptr) {
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        UpdateWindow(hwnd);
      }
    }

    ~Window() {
      if (hwnd != nullptr) {
        DestroyWindow(hwnd);
      }
      if (registered) {
        UnregisterClassW(kWindowClass, instance);
      }
    }

    static LRESULT CALLBACK on_message(HWND hwnd, UINT message, WPARAM first,
                                       LPARAM second) noexcept {
      if (message == WM_NCCREATE) {
        const auto* create = reinterpret_cast<const CREATESTRUCTW*>(second);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA,
                          reinterpret_cast<LONG_PTR>(create->lpCreateParams));
      }
      auto* window =
          reinterpret_cast<Window*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
      if (window == nullptr) {
        return DefWindowProcW(hwnd, message, first, second);
      }
      switch (message) {
        case WM_PAINT: {
          PAINTSTRUCT paint{};
          const auto dc = BeginPaint(hwnd, &paint);
          SetDCBrushColor(dc, window->color);
          FillRect(dc, &paint.rcPaint,
                   static_cast<HBRUSH>(GetStockObject(DC_BRUSH)));
          EndPaint(hwnd, &paint);
          return 0;
        }
        case WM_ACTIVATE:
          if (window->use == WindowUse::kInput &&
              LOWORD(first) != WA_INACTIVE) {
            SetFocus(hwnd);
          }
          return 0;
        case WM_MOUSEACTIVATE:
          return window->use == WindowUse::kInput ? MA_ACTIVATE : MA_NOACTIVATE;
        case WM_LBUTTONDOWN:
          window->input.mouse_down_at = {GET_X_LPARAM(second),
                                         GET_Y_LPARAM(second)};
          ++window->input.mouse_downs;
          return 0;
        case WM_LBUTTONUP:
          window->input.mouse_up_at = {GET_X_LPARAM(second),
                                       GET_Y_LPARAM(second)};
          ++window->input.mouse_ups;
          return 0;
        case WM_KEYDOWN:
          if (first == VK_F8) {
            ++window->input.key_downs;
          }
          return 0;
        case WM_KEYUP:
          if (first == VK_F8) {
            ++window->input.key_ups;
          }
          return 0;
        case WM_CHAR:
          if (first >= 0x20 && first <= 0x7e &&
              window->input.text.size() < 32) {
            window->input.text.push_back(static_cast<char>(first));
          }
          return 0;
        case WM_CLOSE:
          window->input.close_requested = true;
          return 0;
        default:
          return DefWindowProcW(hwnd, message, first, second);
      }
    }
  };

  DesktopWindow::DesktopWindow(const wchar_t* title, WindowUse use)
      : window_(std::make_unique<Window>(title, use)) {}
  DesktopWindow::~DesktopWindow() = default;
  bool DesktopWindow::ready() const noexcept {
    return window_->hwnd != nullptr;
  }

  bool DesktopWindow::stays_passive_on_click() const noexcept {
    const auto window = window_->hwnd;
    const auto activation = SendMessageW(window, WM_MOUSEACTIVATE, 0,
                                         MAKELPARAM(HTCLIENT, WM_LBUTTONDOWN));
    return (GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_NOACTIVATE) != 0 &&
           activation == MA_NOACTIVATE;
  }

  void DesktopWindow::activate() noexcept {
    if (window_->use != WindowUse::kInput) {
      return;
    }
    ShowWindow(window_->hwnd, SW_SHOW);
    if (SetForegroundWindow(window_->hwnd)) {
      SetFocus(window_->hwnd);
    }
  }

  bool DesktopWindow::focused() const noexcept {
    return GetForegroundWindow() == window_->hwnd &&
           GetFocus() == window_->hwnd;
  }

  void DesktopWindow::paint(std::uint32_t rgb) noexcept {
    window_->color = RGB((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
    RedrawWindow(window_->hwnd, nullptr, nullptr,
                 RDW_INVALIDATE | RDW_UPDATENOW);
  }

  std::optional<Point> DesktopWindow::screen_point(
      Point client_point) const noexcept {
    POINT point{client_point.x, client_point.y};
    if (!ClientToScreen(window_->hwnd, &point)) {
      return std::nullopt;
    }
    return Point{point.x, point.y};
  }

  bool DesktopWindow::owns_screen_point(Point point) const noexcept {
    return WindowFromPoint(POINT{point.x, point.y}) == window_->hwnd;
  }

  bool DesktopWindow::place_on_primary(Point client_point) noexcept {
    const auto monitor = MonitorFromPoint(POINT{}, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO primary{};
    primary.cbSize = sizeof(primary);
    RECT rect{};
    if (!GetMonitorInfoW(monitor, &primary) ||
        !GetWindowRect(window_->hwnd, &rect)) {
      return false;
    }
    const auto width = rect.right - rect.left;
    const auto height = rect.bottom - rect.top;
    const auto& work = primary.rcWork;
    if (width > work.right - work.left || height > work.bottom - work.top) {
      return false;
    }
    const std::array<LONG, 3> xs{
        work.right - width, work.left + (work.right - work.left - width) / 2,
        work.left};
    const std::array<LONG, 3> ys{
        work.top, work.top + (work.bottom - work.top - height) / 2,
        work.bottom - height};
    for (const auto y : ys) {
      for (const auto x : xs) {
        if (!SetWindowPos(window_->hwnd, HWND_TOPMOST, x, y, 0, 0,
                          SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)) {
          continue;
        }
        UpdateWindow(window_->hwnd);
        const auto point = screen_point(client_point);
        const auto placed = bounds();
        if (point && placed && placed->primary_visible &&
            owns_screen_point(*point)) {
          return true;
        }
      }
    }
    return false;
  }

  std::optional<WindowBounds> DesktopWindow::bounds() const noexcept {
    const auto monitor = MonitorFromPoint(POINT{}, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO primary{};
    primary.cbSize = sizeof(primary);
    RECT rect{};
    if (!GetMonitorInfoW(monitor, &primary) ||
        !GetWindowRect(window_->hwnd, &rect)) {
      return std::nullopt;
    }
    const auto& work = primary.rcWork;
    return WindowBounds{
        {rect.left, rect.top},
        {rect.right, rect.bottom},
        IsWindowVisible(window_->hwnd) && !IsIconic(window_->hwnd) &&
            rect.left >= work.left && rect.top >= work.top &&
            rect.right <= work.right && rect.bottom <= work.bottom};
  }

  std::uint32_t DesktopWindow::dpi() const noexcept {
    return GetDpiForWindow(window_->hwnd);
  }

  void DesktopWindow::pump() noexcept {
    MSG message{};
    for (unsigned count = 0;
         count < 64 && PeekMessageW(&message, window_->hwnd, 0, 0, PM_REMOVE);
         ++count) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }

  bool DesktopWindow::post_close() noexcept {
    return PostMessageW(window_->hwnd, WM_CLOSE, 0, 0) != FALSE;
  }

  void DesktopWindow::clear_input() noexcept { window_->input = {}; }
  const WindowInput& DesktopWindow::input() const noexcept {
    return window_->input;
  }

  struct TemporaryDisplayMode::Modes {
    DEVMODEW original{};
    LONG status{DISP_CHANGE_BADMODE};
    bool changed{};
    bool valid{read_mode(ENUM_CURRENT_SETTINGS, original)};
  };

  TemporaryDisplayMode::TemporaryDisplayMode()
      : modes_(std::make_unique<Modes>()) {}
  TemporaryDisplayMode::~TemporaryDisplayMode() {
    static_cast<void>(restore());
  }

  bool TemporaryDisplayMode::change_to_smaller_mode() noexcept {
    if (!modes_->valid || modes_->changed) {
      return false;
    }
    const auto& original = modes_->original;
    DEVMODEW best = empty_mode();
    DEVMODEW candidate{};
    std::uint64_t best_pixels = 0;
    for (DWORD index = 0; read_mode(index, candidate); ++index) {
      if (candidate.dmPelsWidth < 800 || candidate.dmPelsHeight < 600 ||
          candidate.dmPelsWidth >= original.dmPelsWidth ||
          candidate.dmPelsHeight >= original.dmPelsHeight ||
          candidate.dmBitsPerPel != original.dmBitsPerPel ||
          candidate.dmDisplayFrequency < 59) {
        continue;
      }
      const auto pixels = static_cast<std::uint64_t>(candidate.dmPelsWidth) *
                          candidate.dmPelsHeight;
      if (pixels < best_pixels ||
          (pixels == best_pixels &&
           candidate.dmDisplayFrequency <= best.dmDisplayFrequency)) {
        continue;
      }
      candidate.dmFields = kModeFields;
      if (ChangeDisplaySettingsW(&candidate, CDS_TEST) ==
          DISP_CHANGE_SUCCESSFUL) {
        best = candidate;
        best_pixels = pixels;
      }
    }
    if (best_pixels == 0) {
      return false;
    }
    modes_->status = ChangeDisplaySettingsW(&best, 0);
    modes_->changed = modes_->status == DISP_CHANGE_SUCCESSFUL;
    return modes_->changed;
  }

  bool TemporaryDisplayMode::restore() noexcept {
    if (!modes_->changed) {
      return true;
    }
    auto original = modes_->original;
    original.dmFields = kModeFields;
    if (ChangeDisplaySettingsW(&original, 0) != DISP_CHANGE_SUCCESSFUL) {
      return false;
    }
    modes_->changed = false;
    return true;
  }

  std::int32_t TemporaryDisplayMode::change_status() const noexcept {
    return modes_->status;
  }

  std::optional<DisplayMode> current_display_mode() noexcept {
    DEVMODEW mode{};
    if (!read_mode(ENUM_CURRENT_SETTINGS, mode)) {
      return std::nullopt;
    }
    return DisplayMode{mode.dmPelsWidth, mode.dmPelsHeight,
                       mode.dmDisplayFrequency};
  }

  std::uint32_t primary_monitor_dpi() noexcept {
    const auto monitor = MonitorFromPoint(POINT{}, MONITOR_DEFAULTTOPRIMARY);
    UINT dpi = 0;
    UINT vertical = 0;
    return SUCCEEDED(
               GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &dpi, &vertical))
               ? dpi
               : 0;
  }

  std::optional<Point> physical_cursor() noexcept {
    POINT point{};
    if (!GetPhysicalCursorPos(&point)) {
      return std::nullopt;
    }
    return Point{point.x, point.y};
  }

  Point virtual_desktop_size() noexcept {
    return {GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN)};
  }

  std::optional<std::uint64_t> private_bytes() noexcept {
    PROCESS_MEMORY_COUNTERS_EX counters{};
    counters.cb = sizeof(counters);
    if (!GetProcessMemoryInfo(
            GetCurrentProcess(),
            reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters),
            counters.cb)) {
      return std::nullopt;
    }
    return counters.PrivateUsage;
  }

  std::optional<MemoryFootprint> memory_footprint() noexcept {
    const auto commit = private_bytes();
    if (!commit) {
      return std::nullopt;
    }
    MemoryFootprint footprint{.private_commit = *commit};
    std::array<HANDLE, MemoryFootprint::kMaxHeaps> heaps{};
    const auto process_heap = GetProcessHeap();
    footprint.heap_count =
        GetProcessHeaps(static_cast<DWORD>(heaps.size()), heaps.data());
    if (footprint.heap_count <= heaps.size()) {
      for (DWORD i = 0; i < footprint.heap_count; ++i) {
        HEAP_SUMMARY summary{};
        summary.cb = sizeof(summary);
        if (HeapSummary(heaps[i], 0, &summary)) {
          footprint.heaps[footprint.heaps_sampled++] = {
              reinterpret_cast<std::uintptr_t>(heaps[i]), summary.cbAllocated,
              summary.cbCommitted, heaps[i] == process_heap};
          footprint.heap_allocated += summary.cbAllocated;
          footprint.heap_committed += summary.cbCommitted;
        }
      }
    }
    footprint.gdi_objects = GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS);
    footprint.user_objects =
        GetGuiResources(GetCurrentProcess(), GR_USEROBJECTS);
    return footprint;
  }

  std::uint32_t process_id() noexcept { return GetCurrentProcessId(); }

  bool f8_down() noexcept { return key_down(VK_F8); }
  bool left_button_down() noexcept { return key_down(VK_LBUTTON); }

  bool use_physical_pixel_coordinates() noexcept {
    const auto awareness = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2;
    return SetProcessDpiAwarenessContext(awareness) ||
           AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),
                                        awareness);
  }
}  // namespace rd::platform::win::test
