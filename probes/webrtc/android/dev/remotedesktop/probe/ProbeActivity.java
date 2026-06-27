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
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.EditText;
import android.widget.Button;
import android.text.InputType;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.ArrayDeque;
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

/** LAN desktop receiver with an optional file-signaling development probe. */
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
  private final AtomicBoolean cleanupStarted = new AtomicBoolean();
  private boolean probeSent;
  private PairingConnection pairing;
  private final AtomicInteger pendingSignals = new AtomicInteger();
  private boolean authorized, remoteReady;
  private final ArrayDeque<IceCandidate> pendingIce = new ArrayDeque<>();
  private EditText addressInput, codeInput;
  private Button connectButton;
  private LinearLayout connectionForm;
  private boolean answerPublished;
  private final Runnable publishAnswer = () -> writeAnswer();
  private volatile boolean firstFrameRendered, pointerChannelReady;
  private final AtomicInteger pendingClicks = new AtomicInteger();
  private volatile int pointerGeometry;
  // Gesture state and renderer dimensions belong to the UI thread.
  private int displayedWidth, displayedHeight, tapPointerId, touchSlop;
  private float tapX, tapY;
  private boolean tapActive;

  @Override public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    status = new TextView(this);
    status.setText("输入电脑地址和临时配对口令");
    connectionForm = new LinearLayout(this);
    connectionForm.setOrientation(LinearLayout.VERTICAL);
    addressInput = new EditText(this);
    addressInput.setHint("电脑 IPv4 地址，例如 192.168.1.2:18443");
    addressInput.setSingleLine(true);
    addressInput.setImeOptions(EditorInfo.IME_ACTION_NEXT | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
    addressInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    codeInput = new EditText(this);
    codeInput.setHint("Windows 显示的临时配对口令（64 位）");
    codeInput.setSingleLine(true);
    codeInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
    codeInput.setSaveEnabled(false);
    codeInput.setImeOptions(EditorInfo.IME_ACTION_DONE | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
    codeInput.setOnEditorActionListener((view, action, event) -> { startPairing(); return true; });
    connectButton = new Button(this);
    connectButton.setText("连接");
    connectionForm.addView(addressInput);
    connectionForm.addView(codeInput);
    connectionForm.addView(connectButton);
    layout.addView(connectionForm);
    connectButton.setOnClickListener(view -> startPairing());
    renderer = new SurfaceViewRenderer(this);
    renderer.setContentDescription("远程桌面画面");
    renderer.setClickable(true);
    touchSlop = ViewConfiguration.get(this).getScaledTouchSlop();
    renderer.setOnTouchListener((view, event) -> onDesktopTouch(event));
    renderer.addOnLayoutChangeListener((view, left, top, right, bottom,
        oldLeft, oldTop, oldRight, oldBottom) -> {
      tapActive = false;
      pointerGeometry++;
      if (displayedWidth == 0 || displayedHeight == 0) return;
      int[] location = new int[2];
      renderer.getLocationOnScreen(location);
      Log.i(TAG, "pointer_viewport=" + location[0] + "," + location[1] + ","
          + renderer.getWidth() + "," + renderer.getHeight() + " frame="
          + displayedWidth + "x" + displayedHeight);
    });
    FrameLayout desktop = new FrameLayout(this);
    // FIT must be allowed to measure both dimensions. Exact full-width/full-height
    // constraints override SurfaceViewRenderer's aspect-fit measurement and crop.
    desktop.addView(renderer, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
    layout.addView(status);
    layout.addView(desktop, new LinearLayout.LayoutParams(-1, 0, 1));
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
      @Override public void onFirstFrameRendered() {
        firstFrameRendered = true;
        report("first_frame_rendered=true");
      }
      @Override public void onFrameResolutionChanged(int width, int height, int rotation) {
        runOnUiThread(() -> {
          tapActive = false;
          pointerGeometry++;
          displayedWidth = rotation == 0 || rotation == 180 ? width : height;
          displayedHeight = rotation == 0 || rotation == 180 ? height : width;
        });
        report("frame_size=" + width + "x" + height + " rotation=" + rotation);
      }
    });
    renderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);
    rtcThread.start();
    worker = new Handler(rtcThread.getLooper());
    String encodedOffer = getIntent().getStringExtra("offer_b64");
    if (encodedOffer == null) return;
    connectionForm.setVisibility(android.view.View.GONE);
    try {
      String offer = new String(Base64.decode(encodedOffer, Base64.DEFAULT), StandardCharsets.UTF_8);
      worker.post(() -> connect(offer));
    } catch (IllegalArgumentException error) {
      report("invalid_offer=" + error.getMessage());
    }
  }

  private boolean insideDesktop(float x, float y) {
    int width = renderer.getWidth(), height = renderer.getHeight();
    if (displayedWidth <= 0 || displayedHeight <= 0 || width <= 1 || height <= 1) return false;
    // Reject gestures while a new frame aspect ratio is waiting for UI layout.
    if (Math.abs((long) width * displayedHeight - (long) height * displayedWidth)
        > Math.max(displayedWidth, displayedHeight)) return false;
    return x >= 0 && y >= 0 && x < width && y < height;
  }

  private boolean onDesktopTouch(MotionEvent event) {
    if (stopping || !firstFrameRendered || !pointerChannelReady || worker == null) {
      tapActive = false;
      return true;
    }
    int action = event.getActionMasked();
    if (action == MotionEvent.ACTION_DOWN) {
      tapX = event.getX();
      tapY = event.getY();
      tapPointerId = event.getPointerId(0);
      tapActive = event.getPointerCount() == 1 && insideDesktop(tapX, tapY);
    } else if (action == MotionEvent.ACTION_MOVE || action == MotionEvent.ACTION_UP) {
      float x = event.getX(), y = event.getY();
      if (event.getPointerCount() != 1 || event.getPointerId(0) != tapPointerId
          || !withinTap(x, y)) {
        tapActive = false;
      }
      // Android may batch motion samples: an excursion outside and back in
      // still cancels the gesture even when the newest sample is inside.
      for (int i = 0; tapActive && i < event.getHistorySize(); i++) {
        if (!withinTap(event.getHistoricalX(i), event.getHistoricalY(i))) tapActive = false;
      }
      if (action == MotionEvent.ACTION_UP) {
        if (tapActive) {
          int normalizedX = Math.min(65535, Math.round(x * 65535 / (renderer.getWidth() - 1)));
          int normalizedY = Math.min(65535, Math.round(y * 65535 / (renderer.getHeight() - 1)));
          queuePointerClick(normalizedX, normalizedY);
          renderer.performClick();
        }
        tapActive = false;
      }
    } else {
      // Multi-touch and cancelled gestures must never become desktop clicks.
      tapActive = false;
    }
    return true;
  }

  private boolean withinTap(float x, float y) {
    float dx = x - tapX, dy = y - tapY;
    return insideDesktop(x, y) && dx * dx + dy * dy <= touchSlop * touchSlop;
  }

  private void queuePointerClick(int x, int y) {
    if (pendingClicks.incrementAndGet() > 8) {
      pendingClicks.decrementAndGet();
      Log.i(TAG, "pointer_rejected=queue_full");
      return;
    }
    int geometry = pointerGeometry;
    if (!worker.post(() -> {
      try {
        if (stopping || !authorized || pairing == null || !firstFrameRendered
            || geometry != pointerGeometry || channel == null
            || channel.state() != DataChannel.State.OPEN) return;
        // Do not turn congestion into delayed desktop actions.
        if (channel.bufferedAmount() != 0) {
          Log.i(TAG, "pointer_rejected=channel_busy");
          return;
        }
        boolean sent = channel.send(new DataChannel.Buffer(ByteBuffer.wrap(
            ("pointer:click:" + x + ":" + y).getBytes(StandardCharsets.UTF_8)), false));
        Log.i(TAG, "pointer_sent=" + sent + " x=" + x + " y=" + y);
      } finally {
        pendingClicks.decrementAndGet();
      }
    })) pendingClicks.decrementAndGet();
  }

  private void startPairing() {
    if (worker == null || stopping || pairing != null) return;
    String address = addressInput.getText().toString().trim();
    String code = codeInput.getText().toString().trim();
    codeInput.setText("");
    getSystemService(InputMethodManager.class).hideSoftInputFromWindow(codeInput.getWindowToken(), 0);
    connectButton.setEnabled(false);
    Log.i(TAG, "pairing_attempt_started=true");
    report("正在配对…");
    pairing = new PairingConnection(new PairingConnection.Listener() {
      @Override public void onMessage(String message) {
        if (pendingSignals.incrementAndGet() > 128) { pairing.close(); return; }
        worker.post(() -> { pendingSignals.decrementAndGet(); receiveSignal(message); });
      }
      @Override public void onClosed() {
        Log.i(TAG, "pairing_transport_closed=true");
        worker.post(() -> {
          if (!stopping) {
            report("连接已结束或配对失败，请检查地址和口令后重新打开应用");
            stopSession();
          }
        });
      }
    });
    pairing.start(address, code);
  }

  private void receiveSignal(String message) {
    if (stopping) return;
    if (message.equals("denied") || message.equals("busy")) {
      Log.i(TAG, message.equals("busy") ? "pairing_busy=true" : "pairing_denied=true");
      report(message.equals("busy") ? "电脑已有连接，请稍后重试" : "配对失败：口令错误或过期");
      stopSession(); return;
    }
    if (message.equals("accepted") && !authorized) {
      authorized = true;
      report("pairing_authorized=true");
      runOnUiThread(() -> connectionForm.setVisibility(android.view.View.GONE));
    } else if (authorized && message.startsWith("offer\n") && peer == null) {
      connect(message.substring(6));
    } else if (authorized && message.startsWith("ice\n")) {
      String[] parts = message.substring(4).split("\n", 3);
      try {
        if (parts.length != 3 || pendingIce.size() >= 128) throw new IllegalArgumentException();
        IceCandidate candidate = new IceCandidate(parts[0], Integer.parseInt(parts[1]), parts[2]);
        if (remoteReady) addCandidate(candidate); else pendingIce.add(candidate);
      } catch (IllegalArgumentException error) { stopSession(); }
    } else { stopSession(); }
  }

  private void addCandidate(IceCandidate candidate) {
    if (!peer.addIceCandidate(candidate)) { report("remote_ice_failed=true"); stopSession(); }
    else report("remote_ice_added=true");
  }

  private void report(String message) {
    Log.i(TAG, message);
    String display = message;
    if (pairing != null && message.contains("=")) {
      if (message.equals("pairing_authorized=true")) display = "配对成功，正在连接桌面…";
      else if (message.equals("first_frame_rendered=true")) display = "已连接";
      else if (message.startsWith("frame_size=")) display = "已连接 · " + message.substring(11).split(" ")[0];
      else return;
    }
    final String text = display;
    runOnUiThread(() -> status.setText(text));
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
        if (pairing == null && state == PeerConnection.IceGatheringState.COMPLETE) scheduleAnswer();
      }
      @Override public void onIceCandidate(IceCandidate candidate) {
        if (pairing != null) pairing.send("ice\n" + candidate.sdpMid + "\n" + candidate.sdpMLineIndex + "\n" + candidate.sdp);
        else scheduleAnswer();
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
          remoteReady = true;
          while (!pendingIce.isEmpty() && !stopping) addCandidate(pendingIce.remove());
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
                if (!stopping) peer.setLocalDescription(new DescriptionObserver() {
                  @Override public void onSetSuccess() {
                    if (pairing != null) pairing.send("answer\n" + answer.description);
                  }
                }, answer);
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
    if (stopping || channel != null) { incoming.dispose(); return; }
    channel = incoming;
    channel.registerObserver(new DataChannel.Observer() {
      @Override public void onBufferedAmountChange(long previous) {}
      @Override public void onStateChange() { worker.post(() -> updateChannelState()); }
      @Override public void onMessage(DataChannel.Buffer buffer) {
        if (buffer.binary || buffer.data.remaining() > 1024) return;
        byte[] copied = new byte[buffer.data.remaining()];
        buffer.data.get(copied);
        String text = new String(copied, StandardCharsets.UTF_8);
        report("data_received=" + text);
      }
    });
    updateChannelState();
  }

  private void updateChannelState() {
    if (stopping) return;
    pointerChannelReady = authorized && pairing != null && channel != null
        && channel.state() == DataChannel.State.OPEN;
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
      if ("codec".equals(stat.getType())) Log.i(TAG, "codec_stats=" + stat);
    }));
    worker.postDelayed(() -> collectStats(), 2000);
  }

  @Override public void onStop() {
    super.onStop();
    report("activity_stopped=true");
    stopSession();
  }

  private void stopSession() {
    if (!cleanupStarted.compareAndSet(false, true)) return;
    stopping = true;
    pointerChannelReady = false;
    if (worker == null) {
      if (connectivity != null) connectivity.bindProcessToNetwork(null);
      return;
    }
    worker.post(() -> {
      if (pairing != null) pairing.close();
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
