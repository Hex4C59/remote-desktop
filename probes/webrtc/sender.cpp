// Development probe: selectable video source and a test-message echo.
// --serve uses authenticated TLS signaling; file mode remains a developer probe.
#include <atomic>
#include <chrono>
#include <charconv>
#include <deque>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <thread>

#include "api/create_modular_peer_connection_factory.h"
#include "api/data_channel_interface.h"
#include "api/enable_media_with_defaults.h"
#include "api/jsep.h"
#include "api/make_ref_counted.h"
#include "api/peer_connection_interface.h"
#include "api/set_local_description_observer_interface.h"
#include "api/set_remote_description_observer_interface.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_broadcaster.h"
#include "api/video/video_frame.h"
#include "pc/video_track_source.h"
#include "remote_desktop_probe/frame_source.h"
#include "remote_desktop_probe/pairing_server.h"
#include "rtc_base/ssl_adapter.h"
#include "rtc_base/thread.h"
#if defined(WEBRTC_WIN)
#include "remote_desktop_probe/pointer_input.h"
#include "rtc_base/win32_socket_init.h"
#endif

namespace {
using Clock = std::chrono::steady_clock;

class SubmittedVideoSource : public webrtc::VideoTrackSource {
 public:
  explicit SubmittedVideoSource(bool desktop) : VideoTrackSource(false), desktop_(desktop) {}
  bool is_screencast() const override { return desktop_; }
  void Push(const webrtc::scoped_refptr<webrtc::I420Buffer>& buffer) {
    const auto now = std::chrono::duration_cast<std::chrono::microseconds>(
        Clock::now().time_since_epoch()).count();
    broadcaster_.OnFrame(webrtc::VideoFrame::Builder()
        .set_video_frame_buffer(buffer).set_timestamp_us(now)
        .set_rotation(webrtc::kVideoRotation_0).build());
  }
 protected:
  webrtc::VideoSourceInterface<webrtc::VideoFrame>* source() override {
    return &broadcaster_;
  }
 private:
  const bool desktop_;
  webrtc::VideoBroadcaster broadcaster_;
};

struct ProbeState {
  std::atomic<bool> failed{false};
  std::atomic<bool> ended{false};
  std::atomic<bool> gathered{false};
  std::atomic<bool> local_ready{false};
  std::atomic<bool> answer_applied{false};
  std::atomic<int> echoed{0};
};

class LocalObserver : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  explicit LocalObserver(std::shared_ptr<ProbeState> state) : state_(std::move(state)) {}
  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
    state_->local_ready = error.ok();
    if (!error.ok()) {
      std::cerr << "set_local_failed=" << error.message() << std::endl;
      state_->failed = true;
    }
  }
 private:
  std::shared_ptr<ProbeState> state_;
};

class RemoteObserver : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  explicit RemoteObserver(std::shared_ptr<ProbeState> state) : state_(std::move(state)) {}
  void OnSetRemoteDescriptionComplete(webrtc::RTCError error) override {
    state_->answer_applied = error.ok();
    if (!error.ok()) {
      std::cerr << "set_remote_failed=" << error.message() << std::endl;
      state_->failed = true;
    }
  }
 private:
  std::shared_ptr<ProbeState> state_;
};

class OfferObserver : public webrtc::CreateSessionDescriptionObserver {
 public:
  OfferObserver(webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc,
                std::shared_ptr<ProbeState> state)
      : pc_(std::move(pc)), state_(std::move(state)) {}
  void OnSuccess(webrtc::SessionDescriptionInterface* description) override {
    pc_->SetLocalDescription(
        std::unique_ptr<webrtc::SessionDescriptionInterface>(description),
        webrtc::make_ref_counted<LocalObserver>(state_));
  }
  void OnFailure(webrtc::RTCError error) override {
    std::cerr << "create_offer_failed=" << error.message() << std::endl;
    state_->failed = true;
  }
 private:
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc_;
  std::shared_ptr<ProbeState> state_;
};

class Sender : public webrtc::PeerConnectionObserver,
               public webrtc::DataChannelObserver {
 public:
  Sender() : state_(std::make_shared<ProbeState>()),
             signaling_(webrtc::Thread::CreateWithSocketServer()) {}
  ~Sender() {
    input_enabled_ = false;
    if (signaling_started_) {
      signaling_->BlockingCall([this] {
        if (channel_) { channel_->UnregisterObserver(); channel_->Close(); }
        if (pc_) pc_->Close();
        channel_ = nullptr;
        pc_ = nullptr;
        source_ = nullptr;
        factory_ = nullptr;
      });
      signaling_->Stop();
    }
  }
  int Run(const std::string& offer_path, const std::string& answer_path, bool desktop, desktop_probe::PairingServer* pairing = nullptr) {
    pairing_ = pairing;
    auto framesource = desktop_probe::CreatePatternSource();
#if defined(WEBRTC_WIN)
    if (desktop) framesource = desktop_probe::CreateDesktopSource();
#else
    if (desktop) { std::cerr << "desktop_error=windows_required\n"; return 2; }
#endif
    if (!framesource->Initialize()) return 1;
#if defined(WEBRTC_WIN)
    // Input is owned by the authenticated session, never by file probe mode.
    std::unique_ptr<desktop_probe::PointerInput> pointer;
    if (pairing_ && pairing_->Authorized() && !pairing_->Ended()) {
      if (auto bounds = framesource->InputBounds()) {
        pointer = std::make_unique<desktop_probe::PointerInput>(*bounds);
      }
    }
#endif
    webrtc::scoped_refptr<webrtc::I420Buffer> latest;
    if (!signaling_->Start()) return 1;
    signaling_started_ = true;
    webrtc::PeerConnectionFactoryDependencies dependencies;
    dependencies.signaling_thread = signaling_.get();
    webrtc::EnableMediaWithDefaults(dependencies);
    factory_ = webrtc::CreateModularPeerConnectionFactory(std::move(dependencies));
    if (!factory_) { std::cerr << "factory_failed\n"; return 1; }
    webrtc::PeerConnectionInterface::RTCConfiguration config;
    config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
    auto peer = factory_->CreatePeerConnectionOrError(
        config, webrtc::PeerConnectionDependencies(this));
    if (!peer.ok()) { std::cerr << peer.error().message() << '\n'; return 1; }
    pc_ = peer.MoveValue();
    source_ = webrtc::make_ref_counted<SubmittedVideoSource>(desktop);
    auto track = factory_->CreateVideoTrack(source_, desktop ? "desktop" : "test-pattern");
    auto added = pc_->AddTrack(track, {"probe-stream"});
    if (!added.ok()) return 1;
    if (desktop) {
      auto parameters = added.value()->GetParameters();
      parameters.degradation_preference = webrtc::DegradationPreference::MAINTAIN_RESOLUTION;
      for (auto& encoding : parameters.encodings) {
        encoding.max_framerate = 30;
        encoding.max_bitrate_bps = 4000000;
      }
      auto configured = added.value()->SetParameters(parameters);
      if (!configured.ok()) { std::cerr << configured.message() << '\n'; return 1; }
      std::cout << "encoder_config=max_fps:30,max_bitrate_bps:4000000,maintain_resolution"
                << " codec=negotiated_receiver_stats" << std::endl;
    }
    webrtc::DataChannelInit channel_config;
    auto channel = pc_->CreateDataChannelOrError("probe", &channel_config);
    if (!channel.ok()) return 1;
    channel_ = channel.MoveValue();
    channel_->RegisterObserver(this);
    pc_->CreateOffer(webrtc::make_ref_counted<OfferObserver>(pc_, state_).get(),
                     webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());

    bool offer_written = false, answer_submitted = false;
    auto started = Clock::now();
    auto next_frame = started;
    auto connected_at = Clock::time_point::max();
    int frames = 0;
    std::deque<std::string> pending_ice;
    while (!state_->failed && !state_->ended && (pairing_ ? !pairing_->Ended() : Clock::now() - started < std::chrono::minutes(3))) {
      if ((pairing_ ? state_->local_ready.load() : state_->gathered.load()) && !offer_written) {
        std::string sdp;
        signaling_->BlockingCall([&] { pc_->local_description()->ToString(&sdp); });
        if (pairing_) {
          if (!pairing_->Send("offer\n" + sdp)) return 1;
        } else {
        std::ofstream output(offer_path, std::ios::binary);
        output << sdp;
        output.close();
        if (!output) { std::cerr << "offer_write_failed\n"; return 1; }
        std::cout << "offer_ready=" << offer_path << std::endl;
        }
        offer_written = true;
      }
      if (!pairing_ && offer_written && !answer_submitted) {
        std::ifstream input(answer_path, std::ios::binary);
        if (input) {
          const std::string sdp((std::istreambuf_iterator<char>(input)), {});
          if (!sdp.empty()) {
            webrtc::SdpParseError error;
            auto answer = webrtc::CreateSessionDescription(webrtc::SdpType::kAnswer, sdp, &error);
            if (!answer) { std::cerr << "answer_parse_failed=" << error.description << '\n'; return 1; }
            pc_->SetRemoteDescription(std::move(answer),
                webrtc::make_ref_counted<RemoteObserver>(state_));
            answer_submitted = true;
          }
        }
      }
      if (pairing_) {
        std::string message;
        while (pairing_->Receive(message)) {
          if (message.starts_with("answer\n") && !answer_submitted) {
            auto answer = webrtc::CreateSessionDescription(webrtc::SdpType::kAnswer, message.substr(7));
            if (!answer) return 1;
            pc_->SetRemoteDescription(std::move(answer), webrtc::make_ref_counted<RemoteObserver>(state_));
            answer_submitted = true;
          } else if (message.starts_with("ice\n") && pending_ice.size() < 128) {
            pending_ice.push_back(message.substr(4));
          } else { return 1; }
        }
        if (state_->answer_applied) {
          while (!pending_ice.empty()) {
            const std::string ice = std::move(pending_ice.front()); pending_ice.pop_front();
            size_t mid_end = ice.find('\n'), index_end = ice.find('\n', mid_end + 1);
            if (mid_end == std::string::npos || index_end == std::string::npos) return 1;
            int index = -1;
            const auto index_text = std::string_view(ice).substr(mid_end + 1, index_end - mid_end - 1);
            auto parsed = std::from_chars(index_text.data(), index_text.substr(index_text.size()).data(), index);
            if (parsed.ec != std::errc() || parsed.ptr != index_text.substr(index_text.size()).data() || index < 0) return 1;
            std::unique_ptr<webrtc::IceCandidate> candidate(webrtc::CreateIceCandidate(ice.substr(0, mid_end), index, ice.substr(index_end + 1), nullptr));
            if (!candidate || !pc_->AddIceCandidate(candidate.get())) return 1;
            std::cout << "remote_ice_added=true" << std::endl;
          }
        }
        if (!state_->answer_applied && Clock::now() - started > std::chrono::seconds(30)) return 1;
      }
      if (state_->answer_applied) {
        if (connected_at == Clock::time_point::max()) connected_at = Clock::now();
        if (!framesource->Capture(latest)) return 1;
        if (latest) { source_->Push(latest); ++frames; }
#if defined(WEBRTC_WIN)
        if (pointer && latest) {
          input_enabled_ = true;
          std::deque<PendingClick> clicks;
          {
            std::lock_guard lock(input_mutex_);
            clicks.swap(pending_clicks_);
          }
          for (const auto& click : clicks) {
            // Recheck at execution, including queued work after transport loss.
            if (state_->failed || state_->ended || pairing_->Ended() || !pairing_->Authorized()) break;
            if (Clock::now() - click.received > std::chrono::milliseconds(500)) continue;
            if (!pointer->Click(click.message)) { state_->failed = true; break; }
          }
        }
#endif
        if (!pairing_ && Clock::now() - connected_at > std::chrono::seconds(30)) break;
      }
      next_frame += std::chrono::milliseconds(33);
      std::this_thread::sleep_until(next_frame);
      if (Clock::now() - next_frame > std::chrono::milliseconds(100)) next_frame = Clock::now();
    }
    std::cout << "generated_frames=" << frames << " echoed_messages=" << state_->echoed << std::endl;
    return !state_->failed && frames > 0 && state_->echoed > 0 ? 0 : 1;
  }
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState) override {}
  void OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface>) override {}
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override {
    if (pairing_) {
      std::string sdp;
      candidate->ToString(&sdp);
      pairing_->Send("ice\n" + candidate->sdp_mid() + "\n" +
          std::to_string(candidate->sdp_mline_index()) + "\n" + sdp);
    }
  }
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState state) override {
    if (state == webrtc::PeerConnectionInterface::kIceGatheringComplete) state_->gathered = true;
  }
  void OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState state) override {
    std::cout << "peer_state=" << static_cast<int>(state) << std::endl;
    if (pairing_ && (state == webrtc::PeerConnectionInterface::PeerConnectionState::kDisconnected ||
                     state == webrtc::PeerConnectionInterface::PeerConnectionState::kFailed ||
                     state == webrtc::PeerConnectionInterface::PeerConnectionState::kClosed)) {
      input_enabled_ = false;
      if (state == webrtc::PeerConnectionInterface::PeerConnectionState::kFailed) state_->failed = true;
      state_->ended = true;
    }
  }
  void OnStateChange() override {
    if (pairing_ && channel_ &&
        (channel_->state() == webrtc::DataChannelInterface::kClosing ||
         channel_->state() == webrtc::DataChannelInterface::kClosed)) {
      input_enabled_ = false;
      state_->ended = true;
    }
  }
  void OnMessage(const webrtc::DataBuffer& buffer) override {
    if (buffer.binary || buffer.data.size() > 1024) return;
    std::string message(buffer.data.cdata<char>(), buffer.data.size());
    if (message.starts_with("pointer:")) {
      if (!input_enabled_ || state_->failed || state_->ended || !pairing_ ||
          !pairing_->Authorized() || pairing_->Ended()) return;
      std::lock_guard lock(input_mutex_);
      if (pending_clicks_.size() >= 32) { state_->failed = true; return; }
      pending_clicks_.push_back({std::move(message), Clock::now()});
      return;
    }
    // Keep the existing diagnostic echo without reflecting arbitrary input.
    if (message != "probe:1") return;
    auto channel = channel_;
    auto state = state_;
    signaling_->PostTask([channel, state, message = std::move(message)] {
      if (channel && channel->state() == webrtc::DataChannelInterface::kOpen &&
          channel->Send(webrtc::DataBuffer("echo:" + message))) {
        ++state->echoed;
        std::cout << "echo_sent=" << message << std::endl;
      }
    });
  }
 private:
  struct PendingClick {
    std::string message;
    Clock::time_point received;
  };
  std::atomic<bool> input_enabled_{false};
  std::mutex input_mutex_;
  std::deque<PendingClick> pending_clicks_;
  desktop_probe::PairingServer* pairing_ = nullptr;
  std::shared_ptr<ProbeState> state_;
  std::unique_ptr<webrtc::Thread> signaling_;
  bool signaling_started_ = false;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory_;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc_;
  webrtc::scoped_refptr<webrtc::DataChannelInterface> channel_;
  webrtc::scoped_refptr<SubmittedVideoSource> source_;
};
}

int main(int argc, char** argv) {
  if (argc != 2 && argc != 3 && argc != 4) {
    std::cerr << "Usage: sender --serve OR sender OFFER_OUTPUT.sdp ANSWER_INPUT.sdp [pattern|desktop]\n";
    return 2;
  }
#if defined(WEBRTC_WIN)
  webrtc::WinsockInitializer winsock;
#endif
  // The C++ entry-point contract supplies argc valid argv entries; argc is 2, 3 or 4
  // was checked above. Confine the raw C ABI boundary to this span creation.
#pragma clang unsafe_buffer_usage begin
  const std::span<char*> arguments(argv, static_cast<size_t>(argc));
#pragma clang unsafe_buffer_usage end
  if (argc == 2) {
    if (std::string(arguments[1]) != "--serve" || !webrtc::InitializeSSL()) return 2;
    int result = 1;
    {
      desktop_probe::PairingServer pairing;
      if (!pairing.Start()) { std::cerr << "pairing_start_failed=true\n"; }
      else {
        while (!pairing.Authorized() && !pairing.Ended()) std::this_thread::sleep_for(std::chrono::milliseconds(50));
        if (pairing.Authorized() && !pairing.Ended()) { Sender sender; result = sender.Run("", "", true, &pairing); }
      }
    }
    webrtc::CleanupSSL();
    return result;
  }
  const std::string mode = argc == 4 ? arguments[3] : "pattern";
  if (mode != "pattern" && mode != "desktop") {
    std::cerr << "Unknown source mode\n";
    return 2;
  }
  if (!webrtc::InitializeSSL()) return 1;
  int result;
  { Sender sender; result = sender.Run(arguments[1], arguments[2], mode == "desktop"); }
  webrtc::CleanupSSL();
  return result;
}
