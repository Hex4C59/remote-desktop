// Test-only GTK/TLS driver. Credential is sent to the parent through a private
// inherited pipe, never stdout or a file. This is not a product entry point.
#include "remote_desktop_probe/pairing_server.h"
#include "rtc_base/ssl_adapter.h"
#include <gtk/gtk.h>
#include <csignal>
#include <cstdlib>
#include <charconv>
#include <string_view>
#include <iostream>
#include <unistd.h>

namespace {
GtkWidget* Entry(GtkWidget* widget) {
  if (GTK_IS_ENTRY(widget)) return widget;
  if (!GTK_IS_CONTAINER(widget)) return nullptr;
  GList* children = gtk_container_get_children(GTK_CONTAINER(widget));
  GtkWidget* found = nullptr;
  for (GList* child = children; child && !found; child = child->next)
    found = Entry(GTK_WIDGET(child->data));
  g_list_free(children); return found;
}
}
int main() {
  std::signal(SIGPIPE, SIG_IGN);
  if (!gtk_init_check(nullptr, nullptr) || !webrtc::InitializeSSL()) return 1;
  int result = 1;
  {
    int credential_fd = -1;
    const char* fd_env = std::getenv("REMOTE_DESKTOP_CREDENTIAL_FD");
    if (!fd_env) return 1;
    const std::string_view fd_text(fd_env);
    const auto parsed = std::from_chars(fd_text.data(), fd_text.substr(fd_text.size()).data(), credential_fd);
    if (parsed.ec != std::errc() || parsed.ptr != fd_text.substr(fd_text.size()).data() || credential_fd < 3) return 1;
    const auto started = desktop_probe::PairingServer::Clock::now();
    const bool expire = std::getenv("REMOTE_DESKTOP_FIXTURE_EXPIRY") != nullptr;
    desktop_probe::PairingServer pairing([started, expire] {
      const auto now = desktop_probe::PairingServer::Clock::now();
      return expire && now - started > std::chrono::seconds(1) ? now + std::chrono::minutes(6) : now;
    });
    if (!pairing.Start()) return 1;
    GList* windows = gtk_window_list_toplevels();
    GtkWidget* entry = windows ? Entry(GTK_WIDGET(windows->data)) : nullptr;
    g_list_free(windows);
    if (!entry || write(credential_fd, gtk_entry_get_text(GTK_ENTRY(entry)), 64) != 64) return 1;
    close(credential_fd);
    const guint timer = g_timeout_add(10, +[](gpointer data) -> gboolean {
      auto& pairing = *static_cast<desktop_probe::PairingServer*>(data);
      std::string message;
      while (pairing.Receive(message)) {
        if (message == "fixture:echo") pairing.Send("fixture:echo");
        else pairing.Stop();
      }
      pairing.PollUi();
      if (pairing.Ended()) gtk_main_quit();
      return G_SOURCE_CONTINUE;
    }, &pairing);
    gtk_main(); g_source_remove(timer); pairing.Stop(); result = 0;
  }
  webrtc::CleanupSSL();
  return result;
}
