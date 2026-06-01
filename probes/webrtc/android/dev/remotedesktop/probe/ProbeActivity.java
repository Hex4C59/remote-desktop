package dev.remotedesktop.probe;

import android.app.Activity;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.util.Log;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.MediaStreamTrack;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RendererCommon;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoTrack;

/** Development-only probe. SDP is injected by ADB; no desktop input is sent. */
public final class ProbeActivity extends Activity {
  private static final String TAG = "RemoteDesktopProbe";
  private final HandlerThread rtcThread = new HandlerThread("probe-rtc");
  private Handler worker;
  private EglBase egl;
  private SurfaceViewRenderer renderer;
  private TextView status;
  private ConnectivityManager connectivity;
  private PeerConnectionFactory factory;
  private PeerConnection peer;
  private VideoTrack video;
  private DataChannel channel;
  private volatile boolean stopping;
  private boolean probeSent;
  private boolean answerPublished;
  private final Runnable publishAnswer = () -> writeAnswer();

  @Override public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    status = new TextView(this);
    status.setText("等待测试连接");
    renderer = new SurfaceViewRenderer(this);
    layout.addView(status);
    layout.addView(renderer, new LinearLayout.LayoutParams(-1, 0, 1));
    setContentView(layout);
    connectivity = getSystemService(ConnectivityManager.class);
    boolean wifiBound = false;
    for (Network network : connectivity.getAllNetworks()) {
      NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(network);
      if (capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
        wifiBound = connectivity.bindProcessToNetwork(network);
        if (wifiBound) break;
      }
    }
    if (!wifiBound) { report("wifi_binding_failed=true"); return; }
    PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions
        .builder(this).createInitializationOptions());
    egl = EglBase.create();
    renderer.init(egl.getEglBaseContext(), new RendererCommon.RendererEvents() {
      @Override public void onFirstFrameRendered() { report("first_frame_rendered=true"); }
      @Override public void onFrameResolutionChanged(int width, int height, int rotation) {
        report("frame_size=" + width + "x" + height + " rotation=" + rotation);
      }
    });
    rtcThread.start();
    worker = new Handler(rtcThread.getLooper());
    String encodedOffer = getIntent().getStringExtra("offer_b64");
    if (encodedOffer == null) { report("missing_offer=true"); return; }
    try {
      String offer = new String(Base64.decode(encodedOffer, Base64.DEFAULT), StandardCharsets.UTF_8);
      worker.post(() -> connect(offer));
    } catch (IllegalArgumentException error) {
      report("invalid_offer=" + error.getMessage());
    }
  }

  private void report(String message) {
    Log.i(TAG, message);
    runOnUiThread(() -> status.setText(message));
  }

  private abstract class DescriptionObserver implements SdpObserver {
    @Override public void onCreateSuccess(SessionDescription description) {}
    @Override public void onSetSuccess() {}
    @Override public void onCreateFailure(String error) { report("sdp_create_failed=" + error); }
    @Override public void onSetFailure(String error) { report("sdp_set_failed=" + error); }
  }

  private void connect(String offer) {
    if (stopping) return;
    PeerConnectionFactory.Options options = new PeerConnectionFactory.Options();
    options.networkIgnoreMask = PeerConnectionFactory.Options.ADAPTER_TYPE_CELLULAR
        | PeerConnectionFactory.Options.ADAPTER_TYPE_VPN;
    factory = PeerConnectionFactory.builder()
        .setOptions(options)
        .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext()))
        .createPeerConnectionFactory();
    PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(Collections.emptyList());
    config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
    peer = factory.createPeerConnection(config, new PeerConnection.Observer() {
      @Override public void onSignalingChange(PeerConnection.SignalingState state) {}
      @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
        report("ice_state=" + state);
      }
      @Override public void onIceConnectionReceivingChange(boolean receiving) {}
      @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {
        if (state == PeerConnection.IceGatheringState.COMPLETE) scheduleAnswer();
      }
      @Override public void onIceCandidate(IceCandidate candidate) {
        scheduleAnswer();
      }
      @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
      @Override public void onAddStream(MediaStream stream) {}
      @Override public void onRemoveStream(MediaStream stream) {}
      @Override public void onRenegotiationNeeded() {}
      @Override public void onDataChannel(DataChannel incoming) {
        worker.post(() -> attachChannel(incoming));
      }
    });
    if (peer == null) { report("peer_creation_failed=true"); return; }
    peer.setRemoteDescription(new DescriptionObserver() {
      @Override public void onSetSuccess() {
        worker.post(() -> {
          if (stopping) return;
          // Call once: getReceivers() disposes wrappers from its previous call.
          for (RtpReceiver receiver : peer.getReceivers()) {
            MediaStreamTrack track = receiver.track();
            if (track instanceof VideoTrack) {
              video = (VideoTrack) track;
              video.addSink(renderer);
              break;
            }
          }
          peer.createAnswer(new DescriptionObserver() {
            @Override public void onCreateSuccess(SessionDescription answer) {
              worker.post(() -> {
                if (!stopping) peer.setLocalDescription(new DescriptionObserver() {}, answer);
              });
            }
          }, new MediaConstraints());
          worker.postDelayed(() -> collectStats(), 2000);
        });
      }
    }, new SessionDescription(SessionDescription.Type.OFFER, offer));
  }

  private void scheduleAnswer() {
    // Android may report COMPLETE with zero networks, then emit candidates as
    // network callbacks arrive. This file-based probe publishes a quiet snapshot;
    // product signaling must forward candidates instead of assuming one COMPLETE.
    worker.removeCallbacks(publishAnswer);
    worker.postDelayed(publishAnswer, 500);
  }

  private void writeAnswer() {
    if (stopping || answerPublished || peer == null) return;
    SessionDescription answer = peer.getLocalDescription();
    if (answer == null) { report("missing_local_description=true"); return; }
    if (!answer.description.contains("a=candidate:")) return;
    File directory = getExternalFilesDir(null);
    if (directory == null) { report("answer_directory_unavailable=true"); return; }
    File output = new File(directory, "answer.pending");
    try (FileOutputStream stream = new FileOutputStream(output)) {
      stream.write(answer.description.getBytes(StandardCharsets.UTF_8));
      stream.flush();
    } catch (IOException error) {
      report("answer_write_failed=" + error.getMessage());
      return;
    }
    if (!output.renameTo(new File(directory, "answer.sdp"))) {
      report("answer_publish_failed=true");
      return;
    }
    answerPublished = true;
    report("answer_ready=true");
  }

  private void attachChannel(DataChannel incoming) {
    if (stopping) { incoming.dispose(); return; }
    channel = incoming;
    channel.registerObserver(new DataChannel.Observer() {
      @Override public void onBufferedAmountChange(long previous) {}
      @Override public void onStateChange() { worker.post(() -> sendProbe()); }
      @Override public void onMessage(DataChannel.Buffer buffer) {
        if (buffer.binary || buffer.data.remaining() > 1024) return;
        byte[] copied = new byte[buffer.data.remaining()];
        buffer.data.get(copied);
        String text = new String(copied, StandardCharsets.UTF_8);
        report("data_received=" + text);
      }
    });
    sendProbe();
  }

  private void sendProbe() {
    if (stopping || probeSent || channel == null || channel.state() != DataChannel.State.OPEN) return;
    probeSent = channel.send(new DataChannel.Buffer(
        ByteBuffer.wrap("probe:1".getBytes(StandardCharsets.UTF_8)), false));
    report("probe_sent=" + probeSent);
  }

  private void collectStats() {
    if (stopping || peer == null) return;
    peer.getStats(report -> report.getStatsMap().values().forEach(stat -> {
      if ("inbound-rtp".equals(stat.getType())) Log.i(TAG, "inbound_stats=" + stat);
    }));
    worker.postDelayed(() -> collectStats(), 2000);
  }

  @Override public void onStop() {
    super.onStop();
    report("activity_stopped=true");
    if (stopping) return;
    stopping = true;
    if (worker == null) {
      if (connectivity != null) connectivity.bindProcessToNetwork(null);
      return;
    }
    worker.post(() -> {
      if (video != null) video.removeSink(renderer);
      if (channel != null) { channel.unregisterObserver(); channel.close(); channel.dispose(); }
      if (peer != null) peer.dispose();
      if (factory != null) factory.dispose();
      connectivity.bindProcessToNetwork(null);
      runOnUiThread(() -> { renderer.release(); egl.release(); });
      rtcThread.quitSafely();
    });
  }
}
