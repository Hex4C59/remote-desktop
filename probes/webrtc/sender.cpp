// First interoperability probe: synthetic video and a test-message echo.
// SDP travels through local files during this probe, not a product signaling API.
#include <atomic>
#include <chrono>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
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
#include "third_party/libyuv/include/libyuv/planar_functions.h"
#include "rtc_base/ssl_adapter.h"
#include "rtc_base/thread.h"
#if defined(WEBRTC_WIN)
#include "rtc_base/win32_socket_init.h"
#endif

namespace {
using Clock = std::chrono::steady_clock;

class PatternSource : public webrtc::VideoTrackSource {
 public:
  PatternSource() : VideoTrackSource(false) {}
  void Push(int index) {
    constexpr int width = 640, height = 360;
    auto buffer = webrtc::I420Buffer::Create(width, height);
    webrtc::I420Buffer::SetBlack(buffer.get());
    // libyuv owns plane addressing; the moving rectangle stays within all planes.
    const int left = (index * 4) % (width - 120);
    libyuv::I420Rect(buffer->MutableDataY(), buffer->StrideY(),
                    buffer->MutableDataU(), buffer->StrideU(),
                    buffer->MutableDataV(), buffer->StrideV(),
                    left, 0, 120, height, 180, 90, 180);
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
  webrtc::VideoBroadcaster broadcaster_;
};

struct ProbeState {
  std::atomic<bool> failed{false};
  std::atomic<bool> gathered{false};
  std::atomic<bool> answer_applied{false};
  std::atomic<int> echoed{0};
};

class LocalObserver : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  explicit LocalObserver(std::shared_ptr<ProbeState> state) : state_(std::move(state)) {}
  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
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
  int Run(const std::string& offer_path, const std::string& answer_path) {
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
    source_ = webrtc::make_ref_counted<PatternSource>();
    auto track = factory_->CreateVideoTrack(source_, "test-pattern");
    if (!pc_->AddTrack(track, {"probe-stream"}).ok()) return 1;
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
    while (!state_->failed && Clock::now() - started < std::chrono::minutes(3)) {
      if (state_->gathered && !offer_written) {
        std::string sdp;
        signaling_->BlockingCall([&] { pc_->local_description()->ToString(&sdp); });
        std::ofstream output(offer_path, std::ios::binary);
        output << sdp;
        output.close();
        if (!output) { std::cerr << "offer_write_failed\n"; return 1; }
        offer_written = true;
        std::cout << "offer_ready=" << offer_path << std::endl;
      }
      if (offer_written && !answer_submitted) {
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
      if (state_->answer_applied) {
        if (connected_at == Clock::time_point::max()) connected_at = Clock::now();
        source_->Push(frames++);
        if (Clock::now() - connected_at > std::chrono::seconds(30)) break;
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
  void OnIceCandidate(const webrtc::IceCandidate*) override {}
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState state) override {
    if (state == webrtc::PeerConnectionInterface::kIceGatheringComplete) state_->gathered = true;
  }
  void OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState state) override {
    std::cout << "peer_state=" << static_cast<int>(state) << std::endl;
  }
  void OnStateChange() override {}
  void OnMessage(const webrtc::DataBuffer& buffer) override {
    if (buffer.binary || buffer.data.size() > 1024) return;
    std::string message(buffer.data.cdata<char>(), buffer.data.size());
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
  std::shared_ptr<ProbeState> state_;
  std::unique_ptr<webrtc::Thread> signaling_;
  bool signaling_started_ = false;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory_;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc_;
  webrtc::scoped_refptr<webrtc::DataChannelInterface> channel_;
  webrtc::scoped_refptr<PatternSource> source_;
};
}

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "Usage: sender OFFER_OUTPUT.sdp ANSWER_INPUT.sdp (use fresh paths)\n";
    return 2;
  }
#if defined(WEBRTC_WIN)
  webrtc::WinsockInitializer winsock;
#endif
  // The C++ entry-point contract supplies argc valid argv entries; argc == 3
  // was checked above. Confine the raw C ABI boundary to this span creation.
#pragma clang unsafe_buffer_usage begin
  const std::span<char*> arguments(argv, static_cast<size_t>(argc));
#pragma clang unsafe_buffer_usage end
  if (!webrtc::InitializeSSL()) return 1;
  int result;
  { Sender sender; result = sender.Run(arguments[1], arguments[2]); }
  webrtc::CleanupSSL();
  return result;
}
