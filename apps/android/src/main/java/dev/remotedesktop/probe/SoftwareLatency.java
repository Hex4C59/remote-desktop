package dev.remotedesktop.probe;

import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.UUID;
import java.util.zip.Deflater;
import java.util.zip.DeflaterOutputStream;
import org.json.JSONException;
import org.json.JSONObject;
import org.webrtc.VideoFrame;
import org.webrtc.VideoSink;

/** Opt-in evidence capture; frame timestamps precede copying, compression and IO. */
final class SoftwareLatency implements VideoSink {
  private static final long SECOND = 1_000_000_000L;
  private static final long MAX_RING_BYTES = 32L * 1024 * 1024;
  private static final int MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  private final HandlerThread thread = new HandlerThread("software-latency");
  private final Handler background;
  private final File directory;
  private final String session, experiment = UUID.randomUUID().toString();
  private final Runnable changed;
  // All acceptance and reference-count decisions are under this monitor. IO and
  // the preroll ring belong solely to background; retained includes processing.
  private Sample active;
  private int retained, ordinal;
  private long frameSequence;
  private boolean closed;
  private long baselineStartedNs;
  private boolean baselineFinished;
  private final java.util.Map<String, Integer> baselineCounts = new java.util.HashMap<>();
  private volatile String display = "软件测量已开启";

  private static final class Image {
    final long sequence, time, copyNs, compressNs;
    final int width, height, rotation;
    final byte[] compressed;
    Image(long sequence, long time, long copyNs, long compressNs, int width,
        int height, int rotation, byte[] compressed) {
      this.sequence = sequence; this.time = time; this.copyNs = copyNs;
      this.compressNs = compressNs; this.width = width; this.height = height;
      this.rotation = rotation; this.compressed = compressed;
    }
  }
  private static final class Sample {
    final String id, expected, category, phase;
    final File directory;
    final long armedNs;
    final ArrayDeque<Image> ring = new ArrayDeque<>();
    long ringBytes;
    volatile long startNs;
    volatile boolean failed;
    Writer index; // background-owned
    Sample(String id, File directory, String category, String expected, String phase) {
      this.id = id; this.directory = directory; this.category = category;
      this.expected = expected; this.phase = phase;
      armedNs = SystemClock.elapsedRealtimeNanos();
    }
  }
  SoftwareLatency(File parent, String session, Runnable changed) throws IOException {
    if (parent == null) throw new IOException("No app evidence directory");
    directory = new File(new File(parent, "software-measurement"), experiment);
    if (!directory.mkdirs()) throw new IOException("Cannot create fresh evidence directory");
    this.session = session; this.changed = changed;
    thread.start(); background = new Handler(thread.getLooper());
  }
  synchronized boolean busy() { return active != null; }
  synchronized boolean allowsInput() {
    return active == null || (active.startNs == 0
        && SystemClock.elapsedRealtimeNanos() - active.armedNs >= SECOND && !active.failed);
  }
  String display() { return display; }
  synchronized void arm(String category, String expected, boolean warmup) {
    if (closed || active != null || expected.trim().isEmpty()) return;
    String id = String.format(java.util.Locale.ROOT, "%04d", ++ordinal);
    Sample sample = new Sample(id, new File(directory, id), category.trim(),
        expected.trim(), warmup ? "warmup" : "formal");
    active = sample;
    display = "样本 " + id + " · 预留1秒画面后执行一次操作";
    background.post(() -> {
      try {
        if (!sample.directory.mkdir()) throw new IOException("Sample exists");
        sample.index = new OutputStreamWriter(new FileOutputStream(
            new File(sample.directory, "events.jsonl")), StandardCharsets.UTF_8);
        JSONObject row = base(sample, "armed");
        row.put("armed_ns", Long.toString(sample.armedNs));
        row.put("category", sample.category).put("expected_feedback", sample.expected)
            .put("phase", sample.phase).put("clock", "elapsedRealtimeNanos")
            .put("endpoint", "VideoSink.onFrame_entry");
        record(sample, row);
      } catch (IOException | JSONException error) { fail(sample, "initialize_failed"); }
    });
    background.postDelayed(() -> {
      synchronized (this) {
        if (active != sample || sample.startNs != 0) return;
        finish(sample, "not_run");
      }
    }, 15000);
    changed.run();
  }
  // Called only after input validation, immediately before DataChannel.send.
  synchronized boolean beforeSend(String kind, long statisticsSequence) {
    Sample sample = active;
    if (sample == null) return false;
    sample.startNs = SystemClock.elapsedRealtimeNanos();
    final long start = sample.startNs;
    background.post(() -> {
      try {
        JSONObject row = base(sample, "action");
        row.put("start_ns", Long.toString(start)).put("input_kind", kind)
            .put("statistics_seq", statisticsSequence);
        record(sample, row);
        while (!sample.ring.isEmpty()) {
          Image image = sample.ring.removeFirst();
          if (image.time >= start - SECOND) save(sample, image);
        }
        sample.ringBytes = 0;
      } catch (IOException | JSONException error) { fail(sample, "action_write_failed"); }
    });
    display = "样本 " + sample.id + " · 收集5秒反馈画面";
    changed.run();
    return true;
  }
  synchronized void afterSend(boolean sent) {
    Sample sample = active;
    if (sample == null || sample.startNs == 0) return;
    if (!sent) { finish(sample, "send_failed"); return; }
    if (baselineStartedNs != 0 && !baselineFinished && "formal".equals(sample.phase)
        && sample.startNs >= baselineStartedNs && sample.startNs <= baselineStartedNs + 600 * SECOND) {
      baselineCounts.put(sample.category, baselineCounts.getOrDefault(sample.category, 0) + 1);
    }
    background.postDelayed(() -> finish(sample, "captured"), 5000);
  }
  synchronized boolean startBaseline(long firstVideoNs) {
    if (closed || active != null || baselineStartedNs != 0 || firstVideoNs == 0
        || SystemClock.elapsedRealtimeNanos() - firstVideoNs < 30 * SECOND) return false;
    baselineStartedNs = SystemClock.elapsedRealtimeNanos();
    background.postDelayed(() -> finishBaseline(false), 600000);
    display = "十分钟基线已开始 · 每轮按固定流程执行";
    changed.run();
    return true;
  }
  private synchronized void finishBaseline(boolean interrupted) {
    if (baselineStartedNs == 0 || baselineFinished) return;
    baselineFinished = true;
    final long end = Math.min(SystemClock.elapsedRealtimeNanos(), baselineStartedNs + 600 * SECOND);
    final boolean incomplete = interrupted && end - baselineStartedNs < 600 * SECOND;
    int cycles = 5;
    for (String group : new String[] {"text_submit", "compile_start", "program_start", "interrupt_return"}) {
      cycles = Math.min(cycles, baselineCounts.getOrDefault(group, 0));
    }
    final int completed = cycles;
    background.post(() -> {
      try {
        JSONObject run = new JSONObject().put("schema", "lan-baseline-run-v1")
            .put("experiment", experiment).put("session", session)
            .put("clock", "elapsedRealtimeNanos").put("start_ns", Long.toString(baselineStartedNs))
            .put("end_ns", Long.toString(end)).put("interrupted", incomplete)
            .put("cycles_completed", completed)
            .put("cycle_basis", "four_categories_of_sent_operations_requires_workload_audit");
        try (Writer writer = new OutputStreamWriter(new FileOutputStream(
            new File(directory, "baseline.json")), StandardCharsets.UTF_8)) {
          writer.write(run.toString());
        }
        display = incomplete ? "基线中断，已保留记录" : "十分钟窗口已结束，等待离线复核";
      } catch (IOException | JSONException error) { display = "基线记录保存失败"; }
      changed.run();
    });
  }

  @Override public void onFrame(VideoFrame frame) {
    long observed = SystemClock.elapsedRealtimeNanos();
    synchronized (this) {
      Sample sample = active;
      if (closed || sample == null || sample.failed) return;
      if (sample.startNs != 0 && observed > sample.startNs + 5 * SECOND) return;
      long sequence = ++frameSequence;
      if (retained >= 2) {
        background.post(() -> gap(sample, sequence, observed, "queue_overflow"));
        return;
      }
      frame.retain(); ++retained;
      if (!background.post(() -> {
        try { collect(sample, sequence, observed, frame); }
        finally { frame.release(); synchronized (this) { --retained; } }
      })) { --retained; frame.release(); }
    }
  }
  private void collect(Sample sample, long sequence, long observed, VideoFrame frame) {
    if (sample.failed) return;
    VideoFrame.I420Buffer i420 = null;
    try {
      long copyStart = SystemClock.elapsedRealtimeNanos();
      int width = frame.getBuffer().getWidth(), height = frame.getBuffer().getHeight();
      long size = (long) width * height + 2L * ((width + 1) / 2) * ((height + 1) / 2);
      if (size <= 0 || size > MAX_IMAGE_BYTES) { gap(sample, sequence, observed, "image_limit"); return; }
      i420 = frame.getBuffer().toI420();
      if (i420 == null) { gap(sample, sequence, observed, "conversion_failed"); return; }
      byte[] pixels = new byte[(int) size];
      int offset = plane(i420.getDataY(), i420.getStrideY(), width, height, pixels, 0);
      offset = plane(i420.getDataU(), i420.getStrideU(), (width + 1) / 2,
          (height + 1) / 2, pixels, offset);
      plane(i420.getDataV(), i420.getStrideV(), (width + 1) / 2,
          (height + 1) / 2, pixels, offset);
      long copyEnd = SystemClock.elapsedRealtimeNanos();
      ByteArrayOutputStream bytes = new ByteArrayOutputStream(pixels.length / 4);
      Deflater deflater = new Deflater(1);
      try {
        try (DeflaterOutputStream compressor = new DeflaterOutputStream(bytes, deflater)) {
          compressor.write(pixels);
        }
      } finally { deflater.end(); }
      Image image = new Image(sequence, observed, copyEnd - copyStart,
          SystemClock.elapsedRealtimeNanos() - copyEnd, width, height,
          frame.getRotation(), bytes.toByteArray());
      if (sample.startNs == 0) {
        sample.ring.addLast(image); sample.ringBytes += image.compressed.length;
        while (!sample.ring.isEmpty() && (sample.ring.peekFirst().time < observed - SECOND
            || sample.ringBytes > MAX_RING_BYTES)) {
          Image removed = sample.ring.removeFirst(); sample.ringBytes -= removed.compressed.length;
          if (removed.time >= observed - SECOND) gap(sample, removed.sequence, removed.time, "ring_limit");
        }
      } else if (observed >= sample.startNs - SECOND) { save(sample, image); }
    } catch (IOException | JSONException | RuntimeException error) {
      gap(sample, sequence, observed, "capture_failed");
    } finally { if (i420 != null) i420.release(); }
  }
  private static int plane(ByteBuffer source, int stride, int width, int height,
      byte[] output, int offset) {
    ByteBuffer data = source.duplicate();
    for (int row = 0; row < height; row++) {
      data.position(row * stride); data.get(output, offset, width); offset += width;
    }
    return offset;
  }
  private void save(Sample sample, Image image) throws IOException, JSONException {
    long started = SystemClock.elapsedRealtimeNanos();
    String name = "frame-" + image.sequence + ".i420.zlib";
    try (FileOutputStream stream = new FileOutputStream(new File(sample.directory, name))) {
      stream.write(image.compressed);
    }
    JSONObject row = base(sample, "frame");
    row.put("frame_id", image.sequence).put("observed_ns", Long.toString(image.time))
        .put("file", name).put("width", image.width).put("height", image.height)
        .put("rotation", image.rotation).put("copy_ns", Long.toString(image.copyNs))
        .put("compress_ns", Long.toString(image.compressNs))
        .put("write_ns", Long.toString(SystemClock.elapsedRealtimeNanos() - started));
    record(sample, row);
  }
  private JSONObject base(Sample sample, String event) throws JSONException {
    return new JSONObject().put("schema", "software-feedback-v1").put("event", event)
        .put("experiment", experiment).put("session", session).put("operation_id", sample.id);
  }
  private void record(Sample sample, JSONObject row) throws IOException {
    if (sample.index == null) throw new IOException("Index unavailable");
    sample.index.write(row.toString()); sample.index.write('\n');
  }
  private void gap(Sample sample, long sequence, long time, String reason) {
    try { record(sample, base(sample, "gap").put("frame_id", sequence)
        .put("observed_ns", Long.toString(time)).put("reason", reason)); }
    catch (IOException | JSONException error) { fail(sample, "index_write_failed"); }
  }
  private void fail(Sample sample, String reason) {
    sample.failed = true;
    finish(sample, reason);
  }
  private synchronized void finish(Sample sample, String status) {
    if (active != sample) return;
    active = null;
    background.post(() -> {
      boolean writeFailed = false;
      try {
        record(sample, base(sample, "capture_end").put("status", status)
            .put("end_ns", Long.toString(SystemClock.elapsedRealtimeNanos())));
      } catch (IOException | JSONException error) { writeFailed = true; }
      finally {
        if (sample.index != null) {
          try { sample.index.close(); } catch (IOException error) { writeFailed = true; }
          sample.index = null;
        }
        sample.ring.clear(); sample.ringBytes = 0;
      }
      if (writeFailed) {
        sample.failed = true;
        try {
          JSONObject failure = base(sample, "fatal").put("status", "write_failed");
          try (Writer writer = new OutputStreamWriter(new FileOutputStream(
              new File(sample.directory, "failure.json")), StandardCharsets.UTF_8)) {
            writer.write(failure.toString());
          }
        } catch (IOException | JSONException ignored) { /* Surface the failure below. */ }
      }
      display = "样本 " + sample.id + " · " + (writeFailed ? "write_failed" : status) + "；离线复核后生成结果";
      changed.run();
    });
  }
  synchronized void close() {
    if (closed) return;
    closed = true;
    finishBaseline(true);
    if (active != null) finish(active, "session_ended");
    background.post(() -> thread.quitSafely());
  }
}
