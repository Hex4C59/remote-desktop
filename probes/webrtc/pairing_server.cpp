#include "remote_desktop_probe/pairing_server.h"
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
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
constexpr size_t kMaxMessage = 65536;
constexpr size_t kMaxQueue = 128;
struct Connection {
  SOCKET socket = INVALID_SOCKET;
  bssl::UniquePtr<SSL> ssl;
  ~Connection() { ssl.reset(); if (socket != INVALID_SOCKET) closesocket(socket); }
};
bool Ready(SOCKET socket, bool write, int milliseconds) {
  fd_set set;
  FD_ZERO(&set);
  set.fd_count = 1;
  std::span(set.fd_array).front() = socket;
  timeval timeout{milliseconds / 1000, (milliseconds % 1000) * 1000};
  return select(0, write ? nullptr : &set, write ? &set : nullptr, nullptr, &timeout) > 0;
}
// Nonblocking SSL operations with absolute deadlines, including partial frames.
bool Transfer(Connection& c, std::span<char> data, bool write) {
  auto deadline = Clock::now() + std::chrono::seconds(5);
  while (!data.empty() && Clock::now() < deadline) {
    int n = write ? SSL_write(c.ssl.get(), data.data(), static_cast<int>(data.size()))
                  : SSL_read(c.ssl.get(), data.data(), static_cast<int>(data.size()));
    if (n > 0) { data = data.subspan(n); continue; }
    int error = SSL_get_error(c.ssl.get(), n);
    if (error != SSL_ERROR_WANT_READ && error != SSL_ERROR_WANT_WRITE) return false;
    Ready(c.socket, error == SSL_ERROR_WANT_WRITE, 100);
  }
  return data.empty();
}
bool SendFrame(Connection& c, std::string message) {
  if (message.empty() || message.size() > kMaxMessage) return false;
  uint32_t length = htonl(static_cast<uint32_t>(message.size()));
  auto bytes = std::as_writable_bytes(std::span(&length, 1));
  return Transfer(c, {reinterpret_cast<char*>(bytes.data()), bytes.size()}, true) &&
         Transfer(c, std::span(message), true);
}
bool ReadFrame(Connection& c, std::string& message) {
  uint32_t length = 0;
  auto bytes = std::as_writable_bytes(std::span(&length, 1));
  if (!Transfer(c, {reinterpret_cast<char*>(bytes.data()), bytes.size()}, false)) return false;
  length = ntohl(length);
  if (!length || length > kMaxMessage) return false;
  message.resize(length);
  return Transfer(c, std::span(message), false);
}
LRESULT CALLBACK PairingWindow(HWND window, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_APP) { ShowWindow(window, SW_HIDE); return 0; }
  if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcA(window, message, w, l);
}
}
struct PairingServer::Impl {
  bssl::UniquePtr<SSL_CTX> context;
  std::string code;
  std::atomic<bool> authorized{false}, ended{false}, stop{false};
  std::atomic<HWND> window{nullptr};
  SOCKET listener = INVALID_SOCKET;
  std::thread accept_thread, session_thread, ui_thread;
  std::mutex mutex;
  std::deque<std::string> outgoing, incoming;
  Clock::time_point expires;
  ~Impl() {
    stop = true;
    if (accept_thread.joinable()) accept_thread.join();
    if (session_thread.joinable()) session_thread.join();
    if (listener != INVALID_SOCKET) closesocket(listener);
    if (HWND hwnd = window.load()) PostMessage(hwnd, WM_CLOSE, 0, 0);
    if (ui_thread.joinable()) ui_thread.join();
    OPENSSL_cleanse(code.data(), code.size());
  }
  bool Push(std::deque<std::string>& queue, std::string message) {
    std::lock_guard lock(mutex);
    if (message.size() > kMaxMessage || queue.size() >= kMaxQueue) { ended = true; return false; }
    queue.push_back(std::move(message));
    return true;
  }
  bool Pop(std::deque<std::string>& queue, std::string& message) {
    std::lock_guard lock(mutex);
    if (queue.empty()) return false;
    message = std::move(queue.front()); queue.pop_front(); return true;
  }
  void ShowCode() {
    WNDCLASSA cls{};
    cls.lpfnWndProc = PairingWindow;
    cls.hInstance = GetModuleHandle(nullptr);
    cls.lpszClassName = "RemoteDesktopPairing";
    RegisterClassA(&cls);
    HWND hwnd = CreateWindowA(cls.lpszClassName, "Remote Desktop - Temporary pairing code",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, CW_USEDEFAULT, CW_USEDEFAULT,
        790, 190, nullptr, nullptr, cls.hInstance, nullptr);
    window = hwnd;
    if (!hwnd) { ended = true; return; }
    CreateWindowA("STATIC", "Enter PC IPv4 address:18443 and this code on Android. Expires in 5 minutes; one session only.",
        WS_CHILD | WS_VISIBLE, 12, 12, 745, 40, hwnd, nullptr, cls.hInstance, nullptr);
    CreateWindowA("EDIT", code.c_str(), WS_CHILD | WS_VISIBLE | WS_BORDER | ES_READONLY | ES_AUTOHSCROLL,
        12, 60, 745, 30, hwnd, nullptr, cls.hInstance, nullptr);
    ShowWindow(hwnd, SW_SHOW);
    MSG message;
    while (!stop && GetMessage(&message, nullptr, 0, 0) > 0) {
      TranslateMessage(&message); DispatchMessage(&message);
    }
    if (IsWindow(hwnd)) DestroyWindow(hwnd);
    window = nullptr;
    ended = true;
  }
  void Session(std::unique_ptr<Connection> c) {
    auto last_received = Clock::now();
    while (!stop && !ended) {
      std::string message;
      if (Pop(outgoing, message) && !SendFrame(*c, message)) break;
      if (SSL_pending(c->ssl.get()) || Ready(c->socket, false, 50)) {
        if (!ReadFrame(*c, message)) break;
        last_received = Clock::now();
        if (message == "ping") { if (!SendFrame(*c, "pong")) break; }
        else if (!Push(incoming, std::move(message))) break;
      }
      if (Clock::now() - last_received > std::chrono::seconds(20)) break;
    }
    ended = true;
    std::cout << "pairing_session_ended=true\n";
  }
  void Accept() {
    int failures = 0;
    while (!stop && !ended) {
      if (!authorized && (Clock::now() >= expires || failures >= 10)) { ended = true; break; }
      if (!Ready(listener, false, 100)) continue;
      auto c = std::make_unique<Connection>();
      c->socket = accept(listener, nullptr, nullptr);
      if (c->socket == INVALID_SOCKET) continue;
      u_long nonblocking = 1;
      ioctlsocket(c->socket, FIONBIO, &nonblocking);
      c->ssl.reset(SSL_new(context.get()));
      if (!c->ssl || !SSL_set_fd(c->ssl.get(), static_cast<int>(c->socket))) continue;
      auto deadline = Clock::now() + std::chrono::seconds(5);
      bool connected = false;
      while (!stop && Clock::now() < deadline) {
        int result = SSL_accept(c->ssl.get());
        if (result == 1) { connected = true; break; }
        int error = SSL_get_error(c->ssl.get(), result);
        if (error != SSL_ERROR_WANT_READ && error != SSL_ERROR_WANT_WRITE) break;
        Ready(c->socket, error == SSL_ERROR_WANT_WRITE, 100);
      }
      if (!connected) { ++failures; continue; }
      if (authorized) { SendFrame(*c, "busy"); continue; }
      std::string auth;
      bool matches = ReadFrame(*c, auth) && auth.size() == code.size() + 5 &&
          auth.starts_with("auth\n") && CRYPTO_memcmp(std::span(auth).subspan(5).data(), code.data(), code.size()) == 0;
      OPENSSL_cleanse(auth.data(), auth.size());
      if (!matches || Clock::now() >= expires) {
        ++failures; SendFrame(*c, "denied");
        std::cout << "pairing_rejected=true\n"; continue;
      }
      if (!SendFrame(*c, "accepted")) continue;
      authorized = true;
      if (HWND hwnd = window.load()) PostMessage(hwnd, WM_APP, 0, 0);
      std::cout << "pairing_authorized=true\n";
      session_thread = std::thread([this, c = std::move(c)]() mutable { Session(std::move(c)); });
    }
  }
};
PairingServer::PairingServer() : impl_(std::make_unique<Impl>()) {}
PairingServer::~PairingServer() = default;
bool PairingServer::Start() {
  auto& s = *impl_;
  auto identity = webrtc::SSLIdentity::Create("remote-desktop", webrtc::KeyParams::ECDSA());
  if (!identity) { std::cerr << "pairing_error=identity\n"; return false; }
  std::string cert_pem = identity->certificate().ToPEMString();
  std::string key_pem = identity->PrivateKeyToPEMString();
  bssl::UniquePtr<BIO> cert_bio(BIO_new_mem_buf(cert_pem.data(), static_cast<int>(cert_pem.size())));
  bssl::UniquePtr<BIO> key_bio(BIO_new_mem_buf(key_pem.data(), static_cast<int>(key_pem.size())));
  bssl::UniquePtr<X509> cert(PEM_read_bio_X509(cert_bio.get(), nullptr, nullptr, nullptr));
  bssl::UniquePtr<EVP_PKEY> key(PEM_read_bio_PrivateKey(key_bio.get(), nullptr, nullptr, nullptr));
  OPENSSL_cleanse(key_pem.data(), key_pem.size());
  s.context.reset(SSL_CTX_new(TLS_method()));
  if (!cert || !key || !s.context || !SSL_CTX_set_min_proto_version(s.context.get(), TLS1_2_VERSION) ||
      !SSL_CTX_use_certificate(s.context.get(), cert.get()) ||
      !SSL_CTX_use_PrivateKey(s.context.get(), key.get())) { std::cerr << "pairing_error=tls_context\n"; return false; }
  std::array<uint8_t, 48> credential{};
  unsigned int digest_size = 0;
  if (!X509_digest(cert.get(), EVP_sha256(), credential.data(), &digest_size) || digest_size != 32 ||
      !RAND_bytes(std::span(credential).subspan(32).data(), 16)) { std::cerr << "pairing_error=credential\n"; return false; }
  std::array<uint8_t, 65> encoded{};
  if (EVP_EncodeBlock(encoded.data(), credential.data(), credential.size()) != 64) return false;
  s.code.assign(reinterpret_cast<char*>(encoded.data()), 64);
  for (char& ch : s.code) { if (ch == '+') ch = '-'; else if (ch == '/') ch = '_'; }
  OPENSSL_cleanse(credential.data(), credential.size());
  OPENSSL_cleanse(encoded.data(), encoded.size());
  s.listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s.listener == INVALID_SOCKET) { std::cerr << "pairing_error=socket code=" << WSAGetLastError() << "\n"; return false; }
  BOOL exclusive = TRUE;
  setsockopt(s.listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<char*>(&exclusive), sizeof(exclusive));
  sockaddr_in address{};
  address.sin_family = AF_INET; address.sin_port = htons(kPort); address.sin_addr.s_addr = INADDR_ANY;
  if (bind(s.listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) || listen(s.listener, 4)) { std::cerr << "pairing_error=listen code=" << WSAGetLastError() << "\n"; return false; }
  s.expires = Clock::now() + std::chrono::minutes(5);
  s.ui_thread = std::thread([&s] { s.ShowCode(); });
  s.accept_thread = std::thread([&s] { s.Accept(); });
  std::cout << "pairing_listening_port=" << kPort << " expires_seconds=300\n";
  return true;
}
bool PairingServer::Authorized() const { return impl_->authorized; }
bool PairingServer::Ended() const { return impl_->ended; }
bool PairingServer::Send(std::string message) { return impl_->Push(impl_->outgoing, std::move(message)); }
bool PairingServer::Receive(std::string& message) { return impl_->Pop(impl_->incoming, message); }
}
