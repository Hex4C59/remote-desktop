// Linux Xorg sender. Session/media behavior is ported from the Windows sender.
// Product entry accepts authenticated TLS signaling only.
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
#include "api/stats/rtc_stats_collector_callback.h"
#include "api/stats/rtcstats_objects.h"
#include "api/stats/rtc_stats_report.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_broadcaster.h"
#include "api/video/video_frame.h"
#include "pc/video_track_source.h"
#include "remote_desktop_probe/frame_source.h"
#include "remote_desktop_probe/pairing_server.h"
#include "remote_desktop_probe/video_statistics_log.h"
#include "rtc_base/ssl_adapter.h"
#include "rtc_base/thread.h"
#include "remote_desktop_probe/desktop_source.h"
#include "remote_desktop_probe/desktop_session.h"
#include "remote_desktop_probe/x11_input.h"
#include <gtk/gtk.h>
#include <glib-unix.h>
#include <csignal>

namespace {
using Clock = std::chrono::steady_clock;

class SubmittedVideoSource : public webrtc::VideoTrackSource {
 public:
  SubmittedVideoSource() : VideoTrackSource(false) {}
  bool is_screencast() const override { return true; }
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
  webrtc::VideoBroadcaster broadcaster_;
};

struct ProbeState {
  explicit ProbeState(std::shared_ptr<desktop_probe::ConnectionDiagnostics> log)
      : diagnostics(std::move(log)) {}
  std::shared_ptr<desktop_probe::ConnectionDiagnostics> diagnostics;
  std::atomic<bool> stats_pending{false};
  std::atomic<int64_t> snapshot_id{0};
  std::atomic<bool> failed{false};
  std::atomic<bool> ended{false};
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
      state_->diagnostics->Stop("local_sdp_failed");
      state_->failed = true;
      std::cerr << "set_local_failed=true" << std::endl;
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
      state_->diagnostics->Stop("remote_sdp_failed");
      state_->failed = true;
      std::cerr << "set_remote_failed=true" << std::endl;
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
  void OnFailure(webrtc::RTCError) override {
    state_->diagnostics->Stop("create_offer_failed");
    state_->failed = true;
    std::cerr << "create_offer_failed=true" << std::endl;
  }
 private:
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc_;
  std::shared_ptr<ProbeState> state_;
};

const char* IceState(webrtc::PeerConnectionInterface::IceConnectionState state) {
  using P = webrtc::PeerConnectionInterface;
  switch (state) {
    case P::kIceConnectionNew: return "new";
    case P::kIceConnectionChecking: return "checking";
    case P::kIceConnectionConnected: return "connected";
    case P::kIceConnectionCompleted: return "completed";
    case P::kIceConnectionFailed: return "failed";
    case P::kIceConnectionDisconnected: return "disconnected";
    case P::kIceConnectionClosed: return "closed";
    default: return "unknown";
  }
}
const char* PeerState(webrtc::PeerConnectionInterface::PeerConnectionState state) {
  using S = webrtc::PeerConnectionInterface::PeerConnectionState;
  switch (state) {
    case S::kNew: return "new";
    case S::kConnecting: return "connecting";
    case S::kConnected: return "connected";
    case S::kDisconnected: return "disconnected";
    case S::kFailed: return "failed";
    case S::kClosed: return "closed";
  }
  return "unknown";
}
class TransportObserver : public webrtc::RTCStatsCollectorCallback {
 public:
  TransportObserver(std::shared_ptr<ProbeState> state, int64_t id)
      : state_(std::move(state)), id_(id) {}
  void OnStatsDelivered(const webrtc::scoped_refptr<const webrtc::RTCStatsReport>& report) override {
    auto& log = *state_->diagnostics;
    log.Event("snapshot_delivered", "complete", id_);
    log.Event("snapshot_report_time", "microseconds", report->timestamp().us());
    for (const auto* transport : report->GetStatsOfType<webrtc::RTCTransportStats>()) {
      log.Event("dtls_state", transport->dtls_state.value_or("unavailable"));
      log.Event("transport_ice_state", transport->ice_state.value_or("unavailable"));
      log.Event("selected_pair", transport->selected_candidate_pair_id ? "present" : "absent");
      if (transport->selected_candidate_pair_changes)
        log.Event("selected_pair_changes", "count", *transport->selected_candidate_pair_changes);
      if (!transport->selected_candidate_pair_id) continue;
      const auto* pair = report->GetAs<webrtc::RTCIceCandidatePairStats>(*transport->selected_candidate_pair_id);
      if (!pair) continue;
      log.Event("selected_pair_state", pair->state.value_or("unavailable"));
      if (pair->requests_sent) log.Event("ice_requests", "sent", *pair->requests_sent);
      if (pair->responses_received) log.Event("ice_responses", "received", *pair->responses_received);
    }
    state_->stats_pending = false;
  }
 private:
  std::shared_ptr<ProbeState> state_;
  const int64_t id_;
};

class Sender : public webrtc::PeerConnectionObserver,
               public webrtc::DataChannelObserver {
 public:
  explicit Sender(std::shared_ptr<desktop_probe::ConnectionDiagnostics> diagnostics)
      : state_(std::make_shared<ProbeState>(std::move(diagnostics))),
             signaling_(webrtc::Thread::CreateWithSocketServer()) {}
  ~Sender() {
    input_enabled_ = false;
    state_->ended = true;
    state_->diagnostics->Event("rtc_state", "closing");
    size_t cleared_inputs = 0;
    {
      std::lock_guard lock(input_mutex_);
      cleared_inputs = pending_inputs_.size();
      pending_inputs_.clear();
    }
    state_->diagnostics->Event("input_state", "disabled");
    state_->diagnostics->Event("input_queue", "cleared", cleared_inputs);
    if (signaling_started_) {
      signaling_->BlockingCall([this] {
        if (state_->stats_pending)
          state_->diagnostics->Event("snapshot_unfinished", "closing", state_->snapshot_id.load());
        if (channel_) { channel_->UnregisterObserver(); channel_->Close(); }
        if (pc_) pc_->Close();
        channel_ = nullptr;
        pc_ = nullptr;
        source_ = nullptr;
        factory_ = nullptr;
        state_->diagnostics->Event("rtc_state", "closed");
      });
      signaling_->Stop();
    }
  }
  int Run(desktop_probe::PairingServer* pairing) {
    pairing_ = pairing;
    desktop_probe::DesktopSession desktop_session;
    if (!desktop_session.Available()) return Fail("desktop_unavailable");
    statistics_ = std::make_unique<desktop_probe::VideoStatisticsLog>();
    auto framesource = desktop_probe::CreateX11DesktopSource();
    if (!framesource->Initialize()) return Fail("capture_initialization_failed");
    auto bounds = framesource->InputBounds();
    if (!bounds) return Fail("capture_bounds_unavailable");
    desktop_probe::X11Input injector(*bounds);
    if (!injector.valid()) return Fail("input_unavailable");
    webrtc::scoped_refptr<webrtc::I420Buffer> latest;
    if (!signaling_->Start()) return Fail("signaling_thread_failed");
    signaling_started_ = true;
    webrtc::PeerConnectionFactoryDependencies dependencies;
    dependencies.signaling_thread = signaling_.get();
    webrtc::EnableMediaWithDefaults(dependencies);
    factory_ = webrtc::CreateModularPeerConnectionFactory(std::move(dependencies));
    if (!factory_) return Fail("factory_failed");
    webrtc::PeerConnectionInterface::RTCConfiguration config;
    config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
    auto peer = factory_->CreatePeerConnectionOrError(
        config, webrtc::PeerConnectionDependencies(this));
    if (!peer.ok()) return Fail("peer_create_failed");
    pc_ = peer.MoveValue();
    source_ = webrtc::make_ref_counted<SubmittedVideoSource>();
    auto track = factory_->CreateVideoTrack(source_, "desktop");
    auto added = pc_->AddTrack(track, {"probe-stream"});
    if (!added.ok()) return Fail("video_track_failed");
    auto parameters = added.value()->GetParameters();
    parameters.degradation_preference = webrtc::DegradationPreference::MAINTAIN_RESOLUTION;
    for (auto& encoding : parameters.encodings) {
      encoding.max_framerate = 30;
      encoding.max_bitrate_bps = 4000000;
    }
    auto configured = added.value()->SetParameters(parameters);
    if (!configured.ok()) return Fail("encoder_config_failed");
    std::cout << "encoder_config=max_fps:30,max_bitrate_bps:4000000,maintain_resolution"
              << " codec=negotiated_receiver_stats" << std::endl;
    webrtc::DataChannelInit channel_config;
    auto channel = pc_->CreateDataChannelOrError("probe", &channel_config);
    if (!channel.ok()) return Fail("data_channel_create_failed");
    channel_ = channel.MoveValue();
    channel_->RegisterObserver(this);
    pc_->CreateOffer(webrtc::make_ref_counted<OfferObserver>(pc_, state_).get(),
                     webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());

    bool offer_written = false, answer_submitted = false;
    auto started = Clock::now();
    auto next_frame = started;
    auto next_snapshot = started;
    int frames = 0;
    std::deque<std::string> pending_ice;
    while (!state_->failed && !state_->ended && !pairing_->Ended()) {
      if (state_->local_ready.load() && !offer_written) {
        std::string sdp;
        signaling_->BlockingCall([&] { pc_->local_description()->ToString(&sdp); });
        if (!pairing_->Send("offer\n" + sdp)) return Fail("signaling_send_failed");
        offer_written = true;
      }
      if (pairing_) {
        std::string message;
        while (pairing_->Receive(message)) {
          if (message.starts_with("answer\n") && !answer_submitted) {
            auto answer = webrtc::CreateSessionDescription(webrtc::SdpType::kAnswer, message.substr(7));
            if (!answer) return Fail("invalid_answer");
            pc_->SetRemoteDescription(std::move(answer), webrtc::make_ref_counted<RemoteObserver>(state_));
            answer_submitted = true;
          } else if (message.starts_with("ice\n") && pending_ice.size() < 128) {
            pending_ice.push_back(message.substr(4));
          } else { return Fail("unexpected_signaling_message"); }
        }
        if (state_->answer_applied) {
          while (!pending_ice.empty()) {
            const std::string ice = std::move(pending_ice.front()); pending_ice.pop_front();
            size_t mid_end = ice.find('\n'), index_end = ice.find('\n', mid_end + 1);
            if (mid_end == std::string::npos || index_end == std::string::npos) return Fail("invalid_ice_message");
            int index = -1;
            const auto index_text = std::string_view(ice).substr(mid_end + 1, index_end - mid_end - 1);
            auto parsed = std::from_chars(index_text.data(), index_text.substr(index_text.size()).data(), index);
            if (parsed.ec != std::errc() || parsed.ptr != index_text.substr(index_text.size()).data() || index < 0) return Fail("invalid_ice_message");
            std::unique_ptr<webrtc::IceCandidate> candidate(webrtc::CreateIceCandidate(ice.substr(0, mid_end), index, ice.substr(index_end + 1), nullptr));
            if (!candidate || !pc_->AddIceCandidate(candidate.get())) return Fail("ice_candidate_rejected");
            std::cout << "remote_ice_added=true" << std::endl;
          }
        }
        if (!state_->answer_applied && Clock::now() - started > std::chrono::seconds(30)) return Fail("answer_timeout");
      }
      if (Clock::now() >= next_snapshot) {
        signaling_->PostTask([this] { Snapshot("periodic"); });
        next_snapshot = Clock::now() + std::chrono::seconds(10);
      }
      if (state_->answer_applied) {
        const bool captured = framesource->Capture(latest, nullptr);
        if (captured && latest) {
          source_->Push(latest);
          if (++frames == 1) state_->diagnostics->Event("capture_state", "first_frame");
        }
        if (!captured) return Fail("capture_failed");
        if (latest) {
          input_enabled_ = true;
          std::deque<PendingInput> inputs;
          {
            std::lock_guard lock(input_mutex_);
            inputs.swap(pending_inputs_);
          }
          for (const auto& input : inputs) {
            // Recheck at execution, including queued work after transport loss.
            if (state_->failed || state_->ended || pairing_->Ended() || !pairing_->Authorized()) break;
            if (!desktop_session.Available()) { pairing_->Stop("desktop_unavailable"); break; }
            const bool click = input.message.starts_with("pointer:");
            if (Clock::now() - input.received > std::chrono::milliseconds(500)) {
              if (click) continue;
              // Never discard text and then execute a later Enter on a partial
              // command. A stalled keyboard queue revokes the whole session.
              Fail("keyboard_input_expired");
              std::cerr << "keyboard_input_expired=true" << std::endl;
              break;
            }
            if (!injector.Execute(input.message)) {
              Fail("input_execution_failed");
              break;
            }
          }
        }
      }
      next_frame += std::chrono::milliseconds(33);
      std::this_thread::sleep_until(next_frame);
      if (Clock::now() - next_frame > std::chrono::milliseconds(100)) next_frame = Clock::now();
    }
    state_->diagnostics->Event("media_frames", "generated", frames);
    std::cout << "generated_frames=" << frames << " echoed_messages=" << state_->echoed << std::endl;
    return !state_->failed && frames > 0 && state_->echoed > 0 ? 0 : 1;
  }
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState state) override {
    state_->diagnostics->Event("signaling_state", "changed", static_cast<int>(state));
  }
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
    state_->diagnostics->Event("ice_gathering_state", "changed", static_cast<int>(state));
  }
  void OnStandardizedIceConnectionChange(webrtc::PeerConnectionInterface::IceConnectionState state) override {
    state_->diagnostics->Event("ice_state", IceState(state));
  }
  void OnIceConnectionReceivingChange(bool receiving) override {
    state_->diagnostics->Event("ice_receiving", receiving ? "yes" : "no");
  }
  void OnIceCandidateError(const std::string&, int, const std::string&, int code, const std::string&) override {
    state_->diagnostics->Event("ice_candidate_error", "code", code);
  }
  void OnIceSelectedCandidatePairChanged(const webrtc::CandidatePairChangeEvent&) override {
    state_->diagnostics->Event("selected_pair", "changed");
  }
  void OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState state) override {
    using S = webrtc::PeerConnectionInterface::PeerConnectionState;
    if (pairing_ && (state == S::kDisconnected || state == S::kFailed || state == S::kClosed)) {
      state_->diagnostics->Stop(state == S::kDisconnected ? "peer_disconnected" :
          state == S::kFailed ? "peer_failed" : "peer_closed", "peer_state", PeerState(state));
      input_enabled_ = false;
      if (state == S::kFailed) state_->failed = true;
      state_->ended = true;
    } else state_->diagnostics->Event("peer_state", PeerState(state));
    // Revocation above precedes sampling and all potentially slow legacy I/O.
    Snapshot("peer_change");
    std::cout << "peer_state=" << static_cast<int>(state) << std::endl;
  }
  void OnStateChange() override {
    if (!channel_) return;
    const auto state = channel_->state();
    const char* label = "unknown";
    switch (state) {
      case webrtc::DataChannelInterface::kConnecting: label = "connecting"; break;
      case webrtc::DataChannelInterface::kOpen: label = "open"; break;
      case webrtc::DataChannelInterface::kClosing: label = "closing"; break;
      case webrtc::DataChannelInterface::kClosed: label = "closed"; break;
    }
    if (pairing_ && (state == webrtc::DataChannelInterface::kClosing ||
                    state == webrtc::DataChannelInterface::kClosed)) {
      state_->diagnostics->Stop("data_channel_closed", "data_channel_state", label);
      input_enabled_ = false;
      state_->ended = true;
    } else state_->diagnostics->Event("data_channel_state", label);
  }
  void OnMessage(const webrtc::DataBuffer& buffer) override {
    if (buffer.binary || buffer.data.size() > 8200) return;
    std::string message(buffer.data.cdata<char>(), buffer.data.size());
    if (message.starts_with("stats:1:")) {
      if (!statistics_ || state_->failed || state_->ended || !pairing_ ||
          !pairing_->Authorized() || pairing_->Ended()) return;
      auto receipt = statistics_->Record(message.substr(8));
      if (receipt) {
        auto channel = channel_;
        signaling_->PostTask([channel, receipt = std::move(receipt->receipt)] {
          if (channel && channel->state() == webrtc::DataChannelInterface::kOpen &&
              channel->buffered_amount() < 16384) channel->Send(webrtc::DataBuffer(receipt));
        });
      }
      return;
    }
    if (message.size() > 1024) return;
    if (message.starts_with("pointer:") || message.starts_with("text:") ||
        message.starts_with("key:")) {
      if (!input_enabled_ || state_->failed || state_->ended || !pairing_ ||
          !pairing_->Authorized() || pairing_->Ended()) return;
      std::lock_guard lock(input_mutex_);
      if (pending_inputs_.size() >= 32) { Fail("input_queue_limit"); return; }
      pending_inputs_.push_back({std::move(message), Clock::now()});
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
  int Fail(std::string_view reason) {
    state_->diagnostics->Stop(reason);
    state_->failed = true;
    return 1;
  }
  void Snapshot(std::string_view trigger) {
    if (!pc_) return;
    if (state_->stats_pending.exchange(true)) {
      state_->diagnostics->Event("snapshot_skipped", "pending", state_->snapshot_id.load());
      return;
    }
    const auto id = ++state_->snapshot_id;
    state_->diagnostics->Event("snapshot_requested", trigger, id);
    pc_->GetStats(webrtc::make_ref_counted<TransportObserver>(state_, id).get());
  }
  struct PendingInput {
    std::string message;
    Clock::time_point received;
  };
  std::atomic<bool> input_enabled_{false};
  std::mutex input_mutex_;
  std::deque<PendingInput> pending_inputs_;
  desktop_probe::PairingServer* pairing_ = nullptr;
  std::unique_ptr<desktop_probe::VideoStatisticsLog> statistics_;
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
#pragma clang unsafe_buffer_usage begin
  const std::span<char*> arguments(argv, static_cast<size_t>(argc));
#pragma clang unsafe_buffer_usage end
  if (arguments.size() != 2 ||
      (std::string_view(arguments[1]) != "--serve" &&
       std::string_view(arguments[1]) != "--check-environment")) {
    std::cerr << "Usage: linux_sender --serve OR --check-environment\n";
    return 2;
  }
  const bool check = std::string_view(arguments[1]) == "--check-environment";
  desktop_probe::DesktopSession desktop;
  if (!desktop.Available()) {
    std::cerr << "desktop_session_unavailable=true requires=logged_in_unlocked_user_xorg\n";
    return 2;
  }
  if (!XInitThreads() || !gtk_init_check(nullptr, nullptr)) {
    std::cerr << "desktop_display_unavailable=true\n"; return 2;
  }
  if (check) { std::cout << "desktop_environment_ok=true\n"; return 0; }
  std::signal(SIGPIPE, SIG_IGN);
  if (!webrtc::InitializeSSL()) return 1;
  int result = 1;
  auto diagnostics = std::make_shared<desktop_probe::ConnectionDiagnostics>();
  diagnostics->Event("session_state", "starting");
  {
    desktop_probe::PairingServer pairing(Clock::now, diagnostics);
    if (!pairing.Start()) { diagnostics->Stop("pairing_start_failed"); std::cerr << "pairing_start_failed=true\n"; }
    else {
      struct Context {
        desktop_probe::PairingServer& pairing;
        desktop_probe::DesktopSession& desktop;
        std::atomic<bool> finished{false};
        Clock::time_point checked = Clock::now();
      } context{pairing, desktop};
      std::thread capture([&] {
        while (!pairing.Authorized() && !pairing.Ended())
          std::this_thread::sleep_for(std::chrono::milliseconds(50));
        if (pairing.Authorized() && !pairing.Ended()) {
          Sender sender(diagnostics);
          result = sender.Run(&pairing);
          diagnostics->Stop("worker_finished");
        }
        context.finished = true;
      });
      const guint timer = g_timeout_add(50, +[](gpointer data) -> gboolean {
        auto& state = *static_cast<Context*>(data);
        if (Clock::now() - state.checked > std::chrono::seconds(1)) {
          state.checked = Clock::now();
          if (!state.desktop.Available()) {
            state.pairing.Stop("desktop_unavailable"); std::cerr << "desktop_session_ended=true\n";
          }
        }
        state.pairing.PollUi();
        if (state.finished || state.pairing.Ended()) gtk_main_quit();
        return G_SOURCE_CONTINUE;
      }, &context);
      auto stop = +[](gpointer data) -> gboolean {
        static_cast<desktop_probe::PairingServer*>(data)->Stop("process_signal"); return G_SOURCE_CONTINUE;
      };
      const guint interrupt = g_unix_signal_add(SIGINT, stop, &pairing);
      const guint terminate = g_unix_signal_add(SIGTERM, stop, &pairing);
      gtk_main();
      g_source_remove(timer); g_source_remove(interrupt); g_source_remove(terminate);
      pairing.Stop();
      capture.join();
    }
  }
  diagnostics->Finish(result);
  webrtc::CleanupSSL();
  return result;
}
