package dev.remotedesktop.probe;

import android.app.Activity;
import android.graphics.Insets;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.EditText;
import android.widget.Button;
import android.text.InputType;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.ArrayDeque;
import java.util.ArrayList;
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
  private TextView statisticsView;
  private final VideoStatistics statistics = new VideoStatistics();
  private final Handler ui = new Handler(Looper.getMainLooper());
  private final Runnable statisticsPoll = () -> collectStats();
  // Display/receipt state belongs to the UI thread; sampling belongs to worker.
  private long statisticsObservedNs, statisticsSequence, statisticsSaved;
  private String statisticsDisplay;
  private final Runnable statisticsFreshness = new Runnable() {
    @Override public void run() {
      if (stopping) return;
      updateStatisticsText();
      ui.postDelayed(this, 1000);
    }
  };
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
  private Button connectButton, sessionButton;
  private ConnectivityManager.NetworkCallback wifiCallback;
  private boolean cleanupComplete;
  private ScrollView connectionForm;
  private boolean answerPublished;
  private final Runnable publishAnswer = () -> writeAnswer();
  private volatile boolean firstFrameRendered, inputChannelReady;
  private volatile long firstVideoNs;
  private final AtomicInteger pendingInputs = new AtomicInteger();
  private LinearLayout terminalControls, terminalKeyRow;
  private EditText terminalInput;
  private Button sendTextButton;
  private final ArrayList<Button> terminalKeys = new ArrayList<>();
  private boolean textPending, dockedKeyboardVisible, statusBarsHidden;
  private volatile SoftwareLatency softwareLatency;
  private long measurementStatisticsSequence;
  private Button measurementButton;
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
    connectionForm = new ScrollView(this);
    LinearLayout connectionFields = new LinearLayout(this);
    connectionFields.setOrientation(LinearLayout.VERTICAL);
    addressInput = new EditText(this);
    addressInput.setHint("电脑 IPv4 地址，例如 192.168.1.2:18443");
    addressInput.setSingleLine(true);
    addressInput.setText(getIntent().getStringExtra("manual_address"));
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
    connectionFields.addView(addressInput);
    connectionFields.addView(codeInput);
    connectionFields.addView(connectButton);
    connectionForm.addView(connectionFields);
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
    LinearLayout sessionRow = new LinearLayout(this);
    sessionRow.addView(status, new LinearLayout.LayoutParams(0, -2, 1));
    sessionButton = new Button(this);
    sessionButton.setText("结束会话");
    sessionButton.setVisibility(View.GONE);
    sessionButton.setOnClickListener(view -> {
      if (!stopping) stopSession("会话已结束");
      else if (cleanupComplete) {
        sessionButton.setEnabled(false);
        // A manual reconnect gets new handlers, observers and queues. Never
        // revive this instance: late callbacks remain attached to the old view.
        getIntent().removeExtra("offer_b64");
        getIntent().putExtra("manual_address", addressInput.getText().toString());
        recreate();
      }
    });
    sessionRow.addView(sessionButton);
    layout.addView(sessionRow);
    statisticsView = new TextView(this);
    statisticsView.setTextSize(12);
    statisticsView.setMaxLines(3);
    statisticsView.setText("视频统计 · 尚未配对，暂无样本");
    layout.addView(statisticsView);
    layout.addView(desktop, new LinearLayout.LayoutParams(-1, 0, 1));
    createTerminalControls(layout);
    configureWindowInsets(layout);
    setContentView(layout);
    connectivity = getSystemService(ConnectivityManager.class);
    boolean wifiBound = false;
    Network selectedWifi = null;
    for (Network network : connectivity.getAllNetworks()) {
      NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(network);
      if (capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
        wifiBound = connectivity.bindProcessToNetwork(network);
        if (wifiBound) { selectedWifi = network; break; }
      }
    }
    if (!wifiBound) { stopSession("未连接 Wi-Fi；请连接网络后手动重连"); return; }
    final Network sessionWifi = selectedWifi;
    wifiCallback = new ConnectivityManager.NetworkCallback() {
      @Override public void onLost(Network network) {
        if (network.equals(sessionWifi)) runOnUiThread(() -> stopSession("Wi-Fi 已断开，会话已结束"));
      }
    };
    connectivity.registerNetworkCallback(new NetworkRequest.Builder()
        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), wifiCallback);
    PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions
        .builder(this).createInitializationOptions());
    egl = EglBase.create();
    renderer.init(egl.getEglBaseContext(), new RendererCommon.RendererEvents() {
      @Override public void onFirstFrameRendered() {
        firstVideoNs = SystemClock.elapsedRealtimeNanos();
        firstFrameRendered = true;
        report("first_frame_rendered=true");
        updateInputControls();
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
    if (!inputReady()) {
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
    queueInput("pointer:click:" + x + ":" + y, pointerGeometry, sent -> {
      Log.i(TAG, "pointer_sent=" + sent + " x=" + x + " y=" + y);
    });
  }

  private void createTerminalControls(LinearLayout layout) {
    terminalControls = new LinearLayout(this);
    terminalControls.setOrientation(LinearLayout.VERTICAL);
    terminalControls.setVisibility(android.view.View.GONE);
    terminalControls.setFocusableInTouchMode(true);
    LinearLayout textRow = new LinearLayout(this);
    terminalInput = new EditText(this);
    terminalInput.setContentDescription("Terminal text");
    terminalInput.setHint("英文、数字和符号（最多 256 字符）");
    terminalInput.setTextSize(14);
    terminalInput.setSingleLine(true);
    terminalInput.setSaveEnabled(false);
    terminalInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    terminalInput.setImeOptions(EditorInfo.IME_ACTION_NONE | EditorInfo.IME_FLAG_NO_EXTRACT_UI
        | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
    // Composing and editing stay local; only the explicit buttons send input.
    terminalInput.setOnEditorActionListener((view, action, event) -> true);
    textRow.addView(terminalInput, new LinearLayout.LayoutParams(0, inputRowHeight(), 1));
    sendTextButton = new Button(this);
    sendTextButton.setText("发送文本");
    sendTextButton.setContentDescription("Send text");
    sendTextButton.setOnClickListener(view -> sendTerminalText());
    textRow.addView(sendTextButton, new LinearLayout.LayoutParams(-2, inputRowHeight()));
    terminalControls.addView(textRow);
    terminalKeyRow = new LinearLayout(this);
    String[][] keys = {{"Enter", "enter"}, {"Tab", "tab"}, {"Left", "left"},
        {"Right", "right"}, {"Up", "up"}, {"Down", "down"},
        {"Backspace", "backspace"}, {"Ctrl+C", "ctrl+c"}};
    for (String[] key : keys) {
      Button button = new Button(this);
      button.setText(key[0]);
      button.setContentDescription(key[0]);
      button.setAllCaps(false);
      button.setTextSize(12);
      button.setMinWidth(0);
      button.setMinimumWidth(0);
      button.setPadding(0, 0, 0, 0);
      button.setOnClickListener(view -> queueInput("key:" + key[1], -1, sent -> {}));
      terminalKeyRow.addView(button, new LinearLayout.LayoutParams(0, inputRowHeight(), 1));
      terminalKeys.add(button);
    }
    terminalControls.addView(terminalKeyRow);
    measurementButton = new Button(this);
    measurementButton.setText("软件测量（未开启）");
    measurementButton.setOnClickListener(view -> configureMeasurement());
    terminalControls.addView(measurementButton);
    layout.addView(terminalControls);
    updateInputControls();
  }

  private void configureWindowInsets(LinearLayout layout) {
    if (Build.VERSION.SDK_INT >= 30) {
      // SDK 35+ draws behind system UI. adjustResize delivers IME insets;
      // apply them ourselves so the draft and Send stay above the keyboard.
      getWindow().setDecorFitsSystemWindows(false);
      layout.setOnApplyWindowInsetsListener((view, insets) -> {
        Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
            | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
        view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
        dockedKeyboardVisible = insets.getInsets(WindowInsets.Type.ime()).bottom > 0;
        updateKeyboardLayout();
        return WindowInsets.CONSUMED;
      });
    } else {
      layout.setFitsSystemWindows(true);
    }
  }

  private void updateKeyboardLayout() {
    boolean compact = !stopping && dockedKeyboardVisible && terminalControls.getVisibility() == View.VISIBLE;
    if (Build.VERSION.SDK_INT >= 30 && compact != statusBarsHidden) {
      WindowInsetsController controller = getWindow().getInsetsController();
      if (controller != null) {
        statusBarsHidden = compact;
        // Landscape keyboards can leave only a thin strip above the draft.
        // Temporarily reclaim status-bar space while preserving cutout insets.
        if (compact) controller.hide(WindowInsets.Type.statusBars());
        else controller.show(WindowInsets.Type.statusBars());
      }
    }
    status.setVisibility(compact ? View.GONE : View.VISIBLE);
    statisticsView.setVisibility(compact ? View.GONE : View.VISIBLE);
    terminalKeyRow.setVisibility(compact ? View.GONE : View.VISIBLE);
    int textHeight = compact ? Math.round(36 * getResources().getDisplayMetrics().density)
        : inputRowHeight();
    for (View control : new View[] {terminalInput, sendTextButton}) {
      android.view.ViewGroup.LayoutParams params = control.getLayoutParams();
      if (params.height != textHeight) {
        params.height = textHeight;
        control.setLayoutParams(params);
      }
    }
  }

  private int inputRowHeight() {
    return Math.round(44 * getResources().getDisplayMetrics().density);
  }

  private boolean inputReady() {
    return !stopping && firstFrameRendered && inputChannelReady && worker != null;
  }

  private void updateInputControls() {
    runOnUiThread(() -> {
      boolean ready = inputReady();
      terminalInput.setEnabled(ready);
      sendTextButton.setEnabled(ready && !textPending);
      for (Button key : terminalKeys) key.setEnabled(ready);
    });
  }

  private void inputFeedback(String message) {
    runOnUiThread(() -> { if (!stopping) status.setText(message); });
  }

  private void sendTerminalText() {
    if (textPending || !inputReady()) return;
    terminalControls.requestFocus();
    getSystemService(InputMethodManager.class).hideSoftInputFromWindow(terminalInput.getWindowToken(), 0);
    String text = terminalInput.getText().toString();
    if (text.isEmpty() || text.length() > 256) {
      inputFeedback("请输入 1–256 个英文、数字或符号字符；草稿已保留");
      return;
    }
    for (int i = 0; i < text.length(); i++) {
      if (text.charAt(i) < 0x20 || text.charAt(i) > 0x7e) {
        inputFeedback("仅支持英文、数字、空格和 ASCII 符号；草稿已保留");
        return;
      }
    }
    textPending = true;
    updateInputControls();
    queueInput("text:" + text, -1, sent -> {
      textPending = false;
      if (sent && terminalInput.getText().toString().equals(text)) terminalInput.setText("");
      updateInputControls();
    });
  }

  private void configureMeasurement() {
    if (!inputReady()) return;
    if (softwareLatency == null) {
      try {
        softwareLatency = new SoftwareLatency(getExternalFilesDir(null), statistics.session,
            () -> ui.post(() -> { if (!stopping) measurementButton.setText(softwareLatency.display()); }));
        worker.post(() -> { if (!stopping && video != null) video.addSink(softwareLatency); });
      } catch (IOException error) { status.setText("无法创建软件测量目录"); return; }
    }
    if (softwareLatency.busy()) { status.setText("当前样本尚未完成"); return; }
    LinearLayout fields = new LinearLayout(this);
    fields.setOrientation(LinearLayout.VERTICAL);
    EditText category = new EditText(this);
    category.setHint("操作分类，例如 compile_start"); category.setText("manual");
    EditText expected = new EditText(this);
    expected.setHint("预期看到的完整反馈");
    android.widget.CheckBox warmup = new android.widget.CheckBox(this);
    warmup.setText("预热样本");
    fields.addView(category); fields.addView(expected); fields.addView(warmup);
    new android.app.AlertDialog.Builder(this).setTitle("记录下一次桌面操作")
        .setView(fields).setNegativeButton("取消", null)
        .setNeutralButton("开始十分钟基线", (dialog, which) -> {
          if (!softwareLatency.startBaseline(firstVideoNs)) status.setText("请等待30秒预热，或建立新实验会话");
        })
        .setPositiveButton("准备采样", (dialog, which) -> {
          softwareLatency.arm(category.getText().toString(), expected.getText().toString(), warmup.isChecked());
        }).show();
  }

  private interface InputResult { void complete(boolean sent); }

  private void finishInput(InputResult result, boolean sent, String message) {
    runOnUiThread(() -> {
      result.complete(sent && !stopping);
      if (!stopping && message != null) status.setText(message);
    });
  }

  private void queueInput(String message, int geometry, InputResult result) {
    if (!inputReady() || (softwareLatency != null && !softwareLatency.allowsInput())) {
      finishInput(result, false, "桌面尚未连接或会话已结束；未发送输入");
      return;
    }
    if (pendingInputs.incrementAndGet() > 8) {
      pendingInputs.decrementAndGet();
      finishInput(result, false, "输入繁忙，请重试；文本草稿已保留");
      return;
    }
    // All UI actions share the RTC handler and ordered DataChannel. Do not
    // retry automatically: a delayed Enter or Ctrl+C could affect another task.
    if (!worker.post(() -> {
      boolean sent = false;
      boolean measured = false;
      String feedback = "输入未发送，请重试；文本草稿已保留";
      try {
        if (!inputReady() || (softwareLatency != null && !softwareLatency.allowsInput())
            || !authorized || pairing == null || channel == null
            || channel.state() != DataChannel.State.OPEN) {
          feedback = "会话已结束；未发送输入";
        } else if (geometry >= 0 && geometry != pointerGeometry) {
          feedback = "画面已调整，请重新点击";
        } else {
          byte[] bytes = message.getBytes(StandardCharsets.UTF_8);
          long buffered = channel.bufferedAmount();
          // Clicks keep the task03 no-backlog policy; keyboard bursts have a
          // small bound and report rejection without discarding the draft.
          if ((geometry >= 0 && buffered != 0) || buffered + bytes.length > 16384) {
            feedback = "输入通道繁忙，请重试；文本草稿已保留";
          } else {
            if (softwareLatency != null) measured = softwareLatency.beforeSend(message.substring(0, message.indexOf(':')),
                measurementStatisticsSequence);
            sent = channel.send(new DataChannel.Buffer(ByteBuffer.wrap(bytes), false));
            if (sent) feedback = geometry >= 0 ? null : "输入已发送";
          }
        }
      } finally {
        if (measured && softwareLatency != null) softwareLatency.afterSend(sent);
        pendingInputs.decrementAndGet();
        finishInput(result, sent, feedback);
      }
    })) {
      pendingInputs.decrementAndGet();
      finishInput(result, false, "会话已结束；未发送输入");
    }
  }

  private void startPairing() {
    if (worker == null || stopping || pairing != null) return;
    String address = addressInput.getText().toString().trim();
    String code = codeInput.getText().toString().trim();
    codeInput.setText("");
    getSystemService(InputMethodManager.class).hideSoftInputFromWindow(codeInput.getWindowToken(), 0);
    connectButton.setEnabled(false);
    sessionButton.setVisibility(View.VISIBLE);
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
            stopSession("连接已结束或配对失败；请检查网络、地址和口令");
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
      stopSession(message.equals("busy") ? "电脑已有连接，请稍后重试" : "配对失败：口令错误或过期");
      return;
    }
    if (message.equals("accepted") && !authorized) {
      authorized = true;
      report("pairing_authorized=true");
      runOnUiThread(() -> {
        if (stopping) return;
        connectionForm.setVisibility(android.view.View.GONE);
        terminalControls.setVisibility(android.view.View.VISIBLE);
        updateKeyboardLayout();
      });
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
    runOnUiThread(() -> { if (!stopping) status.setText(text); });
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
        if (pairing != null && (state == PeerConnection.IceConnectionState.DISCONNECTED
            || state == PeerConnection.IceConnectionState.FAILED
            || state == PeerConnection.IceConnectionState.CLOSED)) {
          stopSession("桌面连接已断开，会话已结束");
        }
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
    if (peer == null) { stopSession("桌面连接失败，会话已结束"); return; }
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
          runOnUiThread(() -> {
            if (stopping) return;
            statisticsObservedNs = SystemClock.elapsedRealtimeNanos();
            statisticsView.setText("视频统计 · 等待视频样本");
            ui.post(statisticsFreshness);
          });
          collectStats();
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
        if (text.equals("echo:probe:1")) report("data_received=echo:probe:1");
        String prefix = "stats-saved:" + statistics.session + ":";
        if (text.startsWith(prefix)) {
          try {
            long saved = Long.parseLong(text.substring(prefix.length()));
            runOnUiThread(() -> {
              if (!stopping && saved > statisticsSaved && saved <= statisticsSequence) {
                statisticsSaved = saved;
                updateStatisticsText();
              }
            });
          } catch (NumberFormatException ignored) { /* Not a receipt for a sampled sequence. */ }
        }
      }
    });
    updateChannelState();
  }

  private void updateChannelState() {
    if (stopping) return;
    if (pairing != null && channel != null && (channel.state() == DataChannel.State.CLOSING
        || channel.state() == DataChannel.State.CLOSED)) {
      stopSession("输入连接已断开，会话已结束");
      return;
    }
    inputChannelReady = authorized && pairing != null && channel != null
        && channel.state() == DataChannel.State.OPEN;
    updateInputControls();
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
    final long requestedNs = SystemClock.elapsedRealtimeNanos();
    // One request at a time. A missing callback makes the independent UI timer
    // mark data stale instead of accumulating unbounded getStats requests.
    peer.getStats(report -> worker.post(() -> {
      if (stopping) return;
      long observedNs = SystemClock.elapsedRealtimeNanos();
      if (observedNs - requestedNs <= 3_000_000_000L) {
        try {
          VideoStatistics.Sample sample = statistics.sample(report, observedNs);
            measurementStatisticsSequence = sample.sequence;
          runOnUiThread(() -> {
            if (stopping) return;
            statisticsObservedNs = observedNs;
            statisticsSequence = sample.sequence;
            statisticsDisplay = sample.text;
            updateStatisticsText();
          });
          // Telemetry cannot fill the input channel's queue on a dead link.
          // A successful send is only queued; the separate receipt confirms a flush.
          if (authorized && channel != null && channel.state() == DataChannel.State.OPEN
              && channel.bufferedAmount() == 0) {
            byte[] bytes = ("stats:1:" + sample.json).getBytes(StandardCharsets.UTF_8);
            if (bytes.length <= 8200) channel.send(new DataChannel.Buffer(ByteBuffer.wrap(bytes), false));
          }
        } catch (org.json.JSONException error) {
          runOnUiThread(() -> {
            if (!stopping) {
              statisticsDisplay = null;
              statisticsView.setText("视频统计 · 样本不可用");
            }
          });
        }
      }
      worker.postDelayed(statisticsPoll, 1000);
    }));
  }

  private void updateStatisticsText() {
    if (stopping) {
      statisticsView.setText("视频统计 · 会话已结束（非实时）· 最后样本 #" + statisticsSequence
          + " · 电脑最后确认 #" + statisticsSaved);
    } else if (SystemClock.elapsedRealtimeNanos() - statisticsObservedNs > 3_000_000_000L) {
      statisticsView.setText("视频统计 · 采样已过期（非实时）· 最后样本 #" + statisticsSequence
          + " · 电脑最后确认 #" + statisticsSaved);
    } else if (statisticsDisplay != null) {
      statisticsView.setText(statisticsDisplay + " · 电脑已存 #" + statisticsSaved
          + (statisticsSaved < statisticsSequence ? "（当前样本未确认）" : ""));
    }
  }

  @Override public void onStop() {
    super.onStop();
    report("activity_stopped=true");
    stopSession("应用已离开前台，会话已结束");
  }

  private void stopSession() { stopSession("会话已结束"); }

  private void stopSession(String reason) {
    if (!cleanupStarted.compareAndSet(false, true)) return;
    stopping = true;
    inputChannelReady = false;
    updateInputControls();
    runOnUiThread(() -> {
      tapActive = false;
      // EGL release can overtake an asynchronously posted clearImage. Hide the
      // surface immediately so an ended session never retains its last desktop.
      renderer.setVisibility(View.INVISIBLE);
      codeInput.setText("");
      getSystemService(InputMethodManager.class).hideSoftInputFromWindow(terminalInput.getWindowToken(), 0);
      status.setText(reason + "；点击重新连接建立新会话");
      sessionButton.setText("重新连接");
      sessionButton.setVisibility(View.VISIBLE);
      sessionButton.setEnabled(false);
      ui.removeCallbacks(statisticsFreshness);
      updateStatisticsText();
      updateKeyboardLayout();
    });
    if (wifiCallback != null) connectivity.unregisterNetworkCallback(wifiCallback);
    if (worker == null) {
      if (connectivity != null) connectivity.bindProcessToNetwork(null);
      runOnUiThread(() -> { cleanupComplete = true; sessionButton.setEnabled(true); });
      return;
    }
    worker.post(() -> {
      worker.removeCallbacks(statisticsPoll);
      if (pairing != null) pairing.close();
      if (video != null) {
        video.removeSink(renderer);
        if (softwareLatency != null) video.removeSink(softwareLatency);
      }
      if (softwareLatency != null) softwareLatency.close();
      if (channel != null) { channel.unregisterObserver(); channel.close(); channel.dispose(); }
      if (peer != null) peer.dispose();
      if (factory != null) factory.dispose();
      connectivity.bindProcessToNetwork(null);
      runOnUiThread(() -> {
        renderer.release();
        egl.release();
        cleanupComplete = true;
        sessionButton.setEnabled(true);
      });
      rtcThread.quitSafely();
    });
  }
}
