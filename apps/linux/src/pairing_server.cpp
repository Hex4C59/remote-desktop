#include "remote_desktop_probe/pairing_server.h"
#include <gtk/gtk.h>
#include <arpa/inet.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/rand.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>
#include <array>
#include <atomic>
#include <chrono>
#include <deque>
#include <iostream>
#include <mutex>
#include <span>
#include <thread>
#include "rtc_base/ssl_identity.h"

namespace desktop_probe {
namespace {
using Clock = std::chrono::steady_clock;
constexpr int kPort = 18443;
constexpr size_t kMaxMessage = 65536, kMaxQueue = 128;
enum class TransferResult { kOk, kStopped, kDeadline, kPeerClosed, kIoError, kInvalidLength };
struct Connection {
  TransferResult last_result = TransferResult::kOk;
  int socket = -1;
  bssl::UniquePtr<SSL> ssl;
  ~Connection() { ssl.reset(); if (socket >= 0) close(socket); }
};
bool Ready(int socket, bool write, int milliseconds) {
  pollfd descriptor{socket, static_cast<short>(write ? POLLOUT : POLLIN), 0};
  return poll(&descriptor, 1, milliseconds) > 0 &&
         (descriptor.revents & (write ? POLLOUT : POLLIN));
}
bool Transfer(Connection& connection, std::span<char> data, bool write,
              Clock::time_point deadline, const std::atomic<bool>& ended) {
  while (!data.empty() && !ended && Clock::now() < deadline) {
    const int transferred = write
        ? SSL_write(connection.ssl.get(), data.data(), static_cast<int>(data.size()))
        : SSL_read(connection.ssl.get(), data.data(), static_cast<int>(data.size()));
    if (transferred > 0) { data = data.subspan(transferred); continue; }
    const int error = SSL_get_error(connection.ssl.get(), transferred);
    if (error != SSL_ERROR_WANT_READ && error != SSL_ERROR_WANT_WRITE) {
      connection.last_result = error == SSL_ERROR_ZERO_RETURN ? TransferResult::kPeerClosed : TransferResult::kIoError;
      return false;
    }
    Ready(connection.socket, error == SSL_ERROR_WANT_WRITE, 50);
  }
  connection.last_result = ended ? TransferResult::kStopped :
        data.empty() ? TransferResult::kOk : TransferResult::kDeadline;
  return connection.last_result == TransferResult::kOk;
}
bool SendFrame(Connection& connection, std::string message, const std::atomic<bool>& ended) {
  if (message.empty() || message.size() > kMaxMessage) return false;
  const auto deadline = Clock::now() + std::chrono::seconds(5);
  uint32_t length = htonl(static_cast<uint32_t>(message.size()));
  auto bytes = std::as_writable_bytes(std::span(&length, 1));
  return Transfer(connection, {reinterpret_cast<char*>(bytes.data()), bytes.size()}, true, deadline, ended) &&
      Transfer(connection, std::span(message), true, deadline, ended);
}
bool ReadFrame(Connection& connection, std::string& message, const std::atomic<bool>& ended) {
  const auto deadline = Clock::now() + std::chrono::seconds(5);
  uint32_t length = 0;
  auto bytes = std::as_writable_bytes(std::span(&length, 1));
  if (!Transfer(connection, {reinterpret_cast<char*>(bytes.data()), bytes.size()}, false, deadline, ended)) return false;
  length = ntohl(length);
  if (!length || length > kMaxMessage) {
    connection.last_result = TransferResult::kInvalidLength; return false;
  }
  message.resize(length);
  return Transfer(connection, std::span(message), false, deadline, ended);
}
}  // namespace
struct PairingServer::Impl {
  std::shared_ptr<ConnectionDiagnostics> diagnostics;
  bssl::UniquePtr<SSL_CTX> context;
  std::string code;
  std::atomic<bool> authorized{false}, ended{false}, ui_hidden{false};
  std::function<Clock::time_point()> now;
  int listener = -1;
  GtkWidget* window = nullptr;
  GtkWidget* entry = nullptr;
  std::thread accept_thread, session_thread;
  std::mutex mutex;
  std::deque<std::string> outgoing, incoming;
  Clock::time_point expires;
  ~Impl() {
    ended = true;
    if (accept_thread.joinable()) accept_thread.join();
    if (session_thread.joinable()) session_thread.join();
    if (listener >= 0) close(listener);
    if (window) gtk_widget_destroy(window);
    OPENSSL_cleanse(code.data(), code.size());
  }
  void End(std::string_view reason = "local_stop",
           std::string_view event = {}, std::string_view value = {}) {
    diagnostics->Stop(reason, event, value);
    ended = true;
    std::lock_guard lock(mutex);
    outgoing.clear(); incoming.clear();
  }
  bool Push(std::deque<std::string>& queue, std::string message) {
    std::lock_guard lock(mutex);
    if (ended) return false;
    if (message.empty() || message.size() > kMaxMessage || queue.size() >= kMaxQueue) {
      diagnostics->Stop("signaling_queue_limit");
      ended = true; return false;
    }
    queue.push_back(std::move(message)); return true;
  }
  bool Pop(std::deque<std::string>& queue, std::string& message) {
    std::lock_guard lock(mutex);
    if (ended || queue.empty()) return false;
    message = std::move(queue.front()); queue.pop_front(); return true;
  }
  void ShowCode() {
    window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(window), "Remote Desktop — Linux pairing");
    gtk_container_set_border_width(GTK_CONTAINER(window), 16);
    auto* box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_container_add(GTK_CONTAINER(window), box);
    gtk_box_pack_start(GTK_BOX(box), gtk_label_new(
        "Enter this computer's IPv4 address:18443 and the code on Android.\n"
        "Expires in 5 minutes; one session only."), FALSE, FALSE, 0);
    entry = gtk_entry_new();
    gtk_editable_set_editable(GTK_EDITABLE(entry), FALSE);
    gtk_entry_set_width_chars(GTK_ENTRY(entry), 66);
    gtk_entry_set_text(GTK_ENTRY(entry), code.c_str());
    gtk_box_pack_start(GTK_BOX(box), entry, FALSE, FALSE, 0);
    g_signal_connect(window, "delete-event", G_CALLBACK(+[](GtkWidget*, GdkEvent*, gpointer data) -> gboolean {
      static_cast<Impl*>(data)->End(); return TRUE;
    }), this);
    gtk_widget_show_all(window);
  }
  void TransportFailure(const Connection& connection, bool write) {
    // Once another worker requested shutdown, TLS errors are cleanup effects.
    if (ended || connection.last_result == TransferResult::kStopped) return;
    switch (connection.last_result) {
      case TransferResult::kPeerClosed:
        End("tls_peer_closed", "tls_state", "peer_closed"); break;
      case TransferResult::kDeadline:
        End(write ? "tls_write_timeout" : "tls_read_timeout",
            "tls_state", write ? "write_timeout" : "read_timeout"); break;
      case TransferResult::kInvalidLength:
        End("tls_invalid_frame", "tls_state", "invalid_frame"); break;
      default:
        End("tls_io_error", "tls_state", "io_error"); break;
    }
  }
  void Session(std::unique_ptr<Connection> connection) {
    diagnostics->Event("tls_state", "authorized");
    auto last_received = Clock::now();
    while (!ended) {
      std::string message;
      if (Pop(outgoing, message) && !SendFrame(*connection, message, ended)) {
        TransportFailure(*connection, true); break;
      }
      if (SSL_pending(connection->ssl.get()) || Ready(connection->socket, false, 50)) {
        if (!ReadFrame(*connection, message, ended)) {
          TransportFailure(*connection, false); break;
        }
        last_received = Clock::now();
        if (message == "ping") {
          if (!SendFrame(*connection, "pong", ended)) {
            TransportFailure(*connection, true); break;
          }
        } else if (!Push(incoming, std::move(message))) break;
      }
      if (Clock::now() - last_received > std::chrono::seconds(20)) {
        End("heartbeat_timeout", "tls_state", "heartbeat_timeout"); break;
      }
    }
    End("tls_worker_finished");
    diagnostics->Event("tls_state", "closed");
    std::cout << "pairing_session_ended=true\n";
  }
  void Accept() {
    int failures = 0;
    while (!ended) {
      if (!authorized && (now() >= expires || failures >= 10)) {
        End(failures >= 10 ? "pairing_failure_limit" : "pairing_expired");
        std::cout << (failures >= 10 ? "pairing_failure_limit=true\n" : "pairing_expired=true\n");
        break;
      }
      if (!Ready(listener, false, 50)) continue;
      auto connection = std::make_unique<Connection>();
      connection->socket = accept4(listener, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
      if (connection->socket < 0) continue;
      connection->ssl.reset(SSL_new(context.get()));
      if (!connection->ssl || !SSL_set_fd(connection->ssl.get(), connection->socket)) { ++failures; continue; }
      const auto deadline = Clock::now() + std::chrono::seconds(5);
      bool connected = false;
      while (!ended && Clock::now() < deadline) {
        const int result = SSL_accept(connection->ssl.get());
        if (result == 1) { connected = true; break; }
        const int error = SSL_get_error(connection->ssl.get(), result);
        if (error != SSL_ERROR_WANT_READ && error != SSL_ERROR_WANT_WRITE) break;
        Ready(connection->socket, error == SSL_ERROR_WANT_WRITE, 50);
      }
      if (!connected) { ++failures; continue; }
      if (authorized) { SendFrame(*connection, "busy", ended); continue; }
      std::string auth;
      const bool matches = ReadFrame(*connection, auth, ended) && auth.size() == code.size() + 5 &&
          auth.starts_with("auth\n") && CRYPTO_memcmp(std::span(auth).subspan(5).data(), code.data(), code.size()) == 0;
      OPENSSL_cleanse(auth.data(), auth.size());
      if (!matches || now() >= expires) {
        ++failures; SendFrame(*connection, "denied", ended);
        std::cout << "pairing_rejected=true\n"; continue;
      }
      if (!SendFrame(*connection, "accepted", ended)) { ++failures; continue; }
      if (ended) break;
      diagnostics->Event("pairing_state", "authorized");
      authorized = true;
      std::cout << "pairing_authorized=true\n";
      session_thread = std::thread([this, connection = std::move(connection)]() mutable {
        Session(std::move(connection));
      });
    }
  }
};
PairingServer::PairingServer(std::function<Clock::time_point()> now,
                             std::shared_ptr<ConnectionDiagnostics> diagnostics)
    : impl_(std::make_unique<Impl>()) {
  impl_->now = std::move(now);
  impl_->diagnostics = diagnostics ? std::move(diagnostics) : std::make_shared<ConnectionDiagnostics>();
}
PairingServer::~PairingServer() = default;
bool PairingServer::Start() {
  auto& state = *impl_;
  auto identity = webrtc::SSLIdentity::Create("remote-desktop", webrtc::KeyParams::ECDSA());
  if (!identity) return false;
  const std::string cert_pem = identity->certificate().ToPEMString();
  std::string key_pem = identity->PrivateKeyToPEMString();
  bssl::UniquePtr<BIO> cert_bio(BIO_new_mem_buf(cert_pem.data(), static_cast<int>(cert_pem.size())));
  bssl::UniquePtr<BIO> key_bio(BIO_new_mem_buf(key_pem.data(), static_cast<int>(key_pem.size())));
  if (!cert_bio || !key_bio) return false;
  bssl::UniquePtr<X509> cert(PEM_read_bio_X509(cert_bio.get(), nullptr, nullptr, nullptr));
  bssl::UniquePtr<EVP_PKEY> key(PEM_read_bio_PrivateKey(key_bio.get(), nullptr, nullptr, nullptr));
  OPENSSL_cleanse(key_pem.data(), key_pem.size());
  state.context.reset(SSL_CTX_new(TLS_method()));
  if (!cert || !key || !state.context || !SSL_CTX_set_min_proto_version(state.context.get(), TLS1_2_VERSION) ||
      !SSL_CTX_use_certificate(state.context.get(), cert.get()) ||
      !SSL_CTX_use_PrivateKey(state.context.get(), key.get())) return false;
  std::array<uint8_t, 48> credential{};
  unsigned int digest_size = 0;
  if (!X509_digest(cert.get(), EVP_sha256(), credential.data(), &digest_size) || digest_size != 32 ||
      !RAND_bytes(std::span(credential).subspan(32).data(), 16)) return false;
  std::array<uint8_t, 65> encoded{};
  if (EVP_EncodeBlock(encoded.data(), credential.data(), credential.size()) != 64) return false;
  state.code.assign(reinterpret_cast<char*>(encoded.data()), 64);
  for (char& character : state.code) {
    if (character == '+') character = '-'; else if (character == '/') character = '_';
  }
  OPENSSL_cleanse(credential.data(), credential.size());
  OPENSSL_cleanse(encoded.data(), encoded.size());
  state.listener = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, IPPROTO_TCP);
  if (state.listener < 0) return false;
  int reuse = 1;
  if (setsockopt(state.listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse))) return false;
  sockaddr_in address{};
  address.sin_family = AF_INET; address.sin_port = htons(kPort); address.sin_addr.s_addr = INADDR_ANY;
  if (bind(state.listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) ||
      listen(state.listener, 4)) return false;
  state.expires = state.now() + std::chrono::minutes(5);
  state.ShowCode();
  state.accept_thread = std::thread([&state] { state.Accept(); });
  std::cout << "pairing_listening_port=" << kPort << " expires_seconds=300\n";
  return true;
}
bool PairingServer::Authorized() const { return impl_->authorized && impl_->ui_hidden; }
bool PairingServer::Ended() const { return impl_->ended; }
bool PairingServer::Send(std::string message) { return impl_->Push(impl_->outgoing, std::move(message)); }
bool PairingServer::Receive(std::string& message) { return impl_->Pop(impl_->incoming, message); }
void PairingServer::Stop(std::string_view reason) { impl_->End(reason); }
void PairingServer::PollUi() {
  if (impl_->window && !impl_->ui_hidden && (impl_->authorized || Ended())) {
    gtk_entry_set_text(GTK_ENTRY(impl_->entry), "");
    gtk_widget_hide(impl_->window);
    gdk_display_sync(gdk_display_get_default());
    impl_->ui_hidden = true;
  }
}
}  // namespace desktop_probe
