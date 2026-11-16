#include "remote_desktop_probe/desktop_session.h"
#include <cstdlib>
#include <iostream>
#include <string_view>
#include <unistd.h>

namespace desktop_probe {
namespace {
constexpr char kService[] = "org.freedesktop.login1";
}
DesktopSession::DesktopSession() {
  if (getuid() == 0) return;
  bus_ = g_bus_get_sync(G_BUS_TYPE_SYSTEM, nullptr, nullptr);
  if (!bus_) return;
  const char* session = std::getenv("XDG_SESSION_ID");
  GVariant* reply = g_dbus_connection_call_sync(
      bus_, kService, "/org/freedesktop/login1", "org.freedesktop.login1.Manager",
      session && *session ? "GetSession" : "GetSessionByPID",
      session && *session ? g_variant_new("(s)", session)
                          : g_variant_new("(u)", static_cast<guint32>(getpid())),
      G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, nullptr);
  if (!reply) return;
  const char* path = nullptr;
  g_variant_get(reply, "(&o)", &path);
  path_ = path;
  g_variant_unref(reply);
}
DesktopSession::~DesktopSession() { if (bus_) g_object_unref(bus_); }

bool DesktopSession::Available() const {
  if (!bus_ || path_.empty()) return false;
  GVariant* reply = g_dbus_connection_call_sync(
      bus_, kService, path_.c_str(), "org.freedesktop.DBus.Properties", "GetAll",
      g_variant_new("(s)", "org.freedesktop.login1.Session"),
      G_VARIANT_TYPE("(a{sv})"), G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, nullptr);
  if (!reply) return false;
  GVariant* properties = g_variant_get_child_value(reply, 0);
  const char* type = nullptr;
  const char* session_class = nullptr;
  gboolean active = false, locked = true;
  GVariant* user = g_variant_lookup_value(properties, "User", G_VARIANT_TYPE("(uo)"));
  guint32 uid = 0;
  const char* ignored = nullptr;
  if (user) g_variant_get(user, "(u&o)", &uid, &ignored);
  const bool valid = user && uid == getuid() &&
      g_variant_lookup(properties, "Type", "&s", &type) && std::string_view(type) == "x11" &&
      g_variant_lookup(properties, "Class", "&s", &session_class) &&
      std::string_view(session_class) == "user" &&
      g_variant_lookup(properties, "Active", "b", &active) && active &&
      g_variant_lookup(properties, "LockedHint", "b", &locked) && !locked;
  if (user) g_variant_unref(user);
  g_variant_unref(properties);
  g_variant_unref(reply);
  return valid;
}
}  // namespace desktop_probe
