// Owns the native Windows desktop and terminal-services notifications.
// Thread: session only
#include "remotedesktop/platform/win/desktop_event_source_win.h"

#include <cstddef>

#include <windows.h>
#include <wtsapi32.h>

namespace rd::platform::win {
  namespace {
    constexpr wchar_t kWindowClass[] = L"RemoteDesktop.DesktopSignals";
    constexpr std::size_t kMessageBudget = 32;

    PlatformError registration_error(DWORD error) noexcept {
      return error == ERROR_ACCESS_DENIED ? PlatformError::kPermissionDenied
                                          : PlatformError::kUnavailable;
    }

    SessionEvidence read_session(DWORD session_id) noexcept {
      LPWSTR buffer = nullptr;
      DWORD bytes = 0;
      if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, session_id, WTSSessionInfoEx,
                                      &buffer, &bytes)) {
        return SessionEvidence::kUnknown;
      }
      auto evidence = SessionEvidence::kUnknown;
      if (buffer != nullptr && bytes >= sizeof(WTSINFOEXW)) {
        const auto& info = *reinterpret_cast<const WTSINFOEXW*>(buffer);
        if (info.Level == 1) {
          const auto& session = info.Data.WTSInfoExLevel1;
          if (session.SessionId == session_id && session.SessionState == WTSActive &&
              session.UserName[0] != L'\0') {
            if (session.SessionFlags == WTS_SESSIONSTATE_LOCK) {
              evidence = SessionEvidence::kLocked;
            } else if (session.SessionFlags == WTS_SESSIONSTATE_UNLOCK) {
              evidence = SessionEvidence::kUnlocked;
            }
          }
        }
      }
      WTSFreeMemory(buffer);
      return evidence;
    }

    InputDesktopEvidence read_input_desktop() noexcept {
      const auto station = GetProcessWindowStation();
      USEROBJECTFLAGS flags{};
      DWORD required = 0;
      if (station == nullptr ||
          !GetUserObjectInformationW(station, UOI_FLAGS, &flags, sizeof(flags), &required) ||
          (flags.dwFlags & WSF_VISIBLE) == 0) {
        return InputDesktopEvidence::kUnknown;
      }

      const auto desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
      if (desktop == nullptr) {
        return InputDesktopEvidence::kUnknown;
      }
      wchar_t name[256]{};
      const auto read_name = GetUserObjectInformationW(desktop, UOI_NAME, name, sizeof(name), &required);
      CloseDesktop(desktop);
      if (!read_name || required < sizeof(wchar_t) || required > sizeof(name) ||
          name[required / sizeof(wchar_t) - 1] != L'\0') {
        return InputDesktopEvidence::kUnknown;
      }
      if (CompareStringOrdinal(name, -1, L"Default", -1, TRUE) == CSTR_EQUAL) {
        return InputDesktopEvidence::kDefault;
      }
      if (CompareStringOrdinal(name, -1, L"Winlogon", -1, TRUE) == CSTR_EQUAL) {
        return InputDesktopEvidence::kSecure;
      }
      return InputDesktopEvidence::kUnknown;
    }

    class NativeDesktopSignals final : public DesktopSignals {
     public:
      ~NativeDesktopSignals() override { stop(); }

      PlatformResult<void> start(DesktopSignalSink sink, void* context) noexcept override {
        if (hook_owner_ != nullptr || window_ != nullptr) {
          return PlatformError::kAlreadyInitialized;
        }
        if (!ProcessIdToSessionId(GetCurrentProcessId(), &session_id_)) {
          return registration_error(GetLastError());
        }
        if (session_id_ == 0) {
          return PlatformError::kUnavailable;
        }
        module_ = GetModuleHandleW(nullptr);
        if (module_ == nullptr) {
          return registration_error(GetLastError());
        }

        WNDCLASSW window_class{};
        window_class.lpfnWndProc = &window_proc;
        window_class.hInstance = module_;
        window_class.lpszClassName = kWindowClass;
        if (RegisterClassW(&window_class) == 0) {
          return registration_error(GetLastError());
        }
        class_registered_ = true;
        window_ = CreateWindowExW(0, kWindowClass, L"", WS_POPUP,
                                  0, 0, 0, 0, nullptr, nullptr, module_, this);
        if (window_ == nullptr) {
          return rollback(GetLastError());
        }

        // Registration can dispatch messages before the initial probe.
        sink_ = sink;
        context_ = context;
        if (!WTSRegisterSessionNotification(window_, NOTIFY_FOR_THIS_SESSION)) {
          return rollback(GetLastError());
        }
        wts_registered_ = true;
        hook_owner_ = this;
        hook_ = SetWinEventHook(EVENT_SYSTEM_DESKTOPSWITCH, EVENT_SYSTEM_DESKTOPSWITCH,
                                nullptr, &desktop_switched, 0, 0, WINEVENT_OUTOFCONTEXT);
        if (hook_ == nullptr) {
          return rollback(GetLastError());
        }
        return std::monostate{};
      }

      void stop() noexcept override {
        sink_ = nullptr;
        context_ = nullptr;
        if (hook_owner_ == this) {
          hook_owner_ = nullptr;
        }
        if (hook_ != nullptr) {
          UnhookWinEvent(hook_);
          hook_ = nullptr;
        }
        if (wts_registered_) {
          WTSUnRegisterSessionNotification(window_);
          wts_registered_ = false;
        }
        if (window_ != nullptr) {
          DestroyWindow(window_);
          window_ = nullptr;
        }
        if (class_registered_) {
          UnregisterClassW(kWindowClass, module_);
          class_registered_ = false;
        }
      }

      void pump() noexcept override {
        // Peeking dispatches pending sent messages and out-of-context WinEvents on this thread.
        // Remove queued messages only for the private window.
        MSG message{};
        for (std::size_t count = 0; count < kMessageBudget; ++count) {
          if (!PeekMessageW(&message, window_, 0, 0, PM_REMOVE)) {
            break;
          }
          if (message.message == WM_QUIT) {
            PostQuitMessage(static_cast<int>(message.wParam));
            break;
          }
          DispatchMessageW(&message);
        }
      }

      DesktopEvidence probe() noexcept override {
        const auto session = read_session(session_id_);
        if (session != SessionEvidence::kUnlocked) {
          return {session, InputDesktopEvidence::kUnknown};
        }
        return {session, read_input_desktop()};
      }

     private:
      PlatformError rollback(DWORD error) noexcept {
        stop();
        return registration_error(error);
      }

      void emit(DesktopSignal signal) const noexcept {
        if (sink_ != nullptr) {
          sink_(context_, signal);
        }
      }

      void session_changed(WPARAM event) const noexcept {
        switch (event) {
          case WTS_SESSION_LOCK: emit(DesktopSignal::kLock); break;
          case WTS_SESSION_LOGOFF: emit(DesktopSignal::kLogoff); break;
          case WTS_CONSOLE_DISCONNECT:
          case WTS_REMOTE_DISCONNECT: emit(DesktopSignal::kDisconnect); break;
          case WTS_SESSION_UNLOCK:
          case WTS_SESSION_LOGON:
          case WTS_CONSOLE_CONNECT:
          case WTS_REMOTE_CONNECT: emit(DesktopSignal::kRecheck); break;
          default: break;
        }
      }

      static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM first,
                                         LPARAM second) noexcept {
        if (message == WM_NCCREATE) {
          const auto* creation = reinterpret_cast<const CREATESTRUCTW*>(second);
          SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(creation->lpCreateParams));
        } else if (message == WM_WTSSESSION_CHANGE) {
          const auto* self = reinterpret_cast<NativeDesktopSignals*>(
              GetWindowLongPtrW(window, GWLP_USERDATA));
          if (self != nullptr && static_cast<DWORD>(second) == self->session_id_) {
            self->session_changed(first);
          }
          return 0;
        } else if (message == WM_NCDESTROY) {
          SetWindowLongPtrW(window, GWLP_USERDATA, 0);
        }
        return DefWindowProcW(window, message, first, second);
      }

      static void CALLBACK desktop_switched(HWINEVENTHOOK hook, DWORD, HWND, LONG, LONG,
                                            DWORD, DWORD) noexcept {
        if (hook_owner_ != nullptr && hook_owner_->hook_ == hook) {
          hook_owner_->emit(DesktopSignal::kDesktopSwitch);
        }
      }

      static thread_local NativeDesktopSignals* hook_owner_;
      HMODULE module_{};
      HWND window_{};
      HWINEVENTHOOK hook_{};
      DWORD session_id_{};
      DesktopSignalSink sink_{};
      void* context_{};
      bool class_registered_{};
      bool wts_registered_{};
    };

    thread_local NativeDesktopSignals* NativeDesktopSignals::hook_owner_ = nullptr;
  }  // namespace

  std::unique_ptr<DesktopSignals> make_desktop_signals_win() {
    return std::make_unique<NativeDesktopSignals>();
  }
}  // namespace rd::platform::win
