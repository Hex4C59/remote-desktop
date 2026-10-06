package dev.remotedesktop.probe;

import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;
import org.webrtc.RTCStats;
import org.webrtc.RTCStatsReport;

/** Per-session receiver samples. Called only on the RTC worker, never across sessions. */
final class VideoStatistics {
  final String session = UUID.randomUUID().toString();
  private long sequence;
  private RTCStats previous;
  private long previousObservedNs;

  static final class Sample {
    final long sequence;
    final String text;
    final String json;
    Sample(long sequence, String text, String json) {
      this.sequence = sequence;
      this.text = text;
      this.json = json;
    }
  }

  Sample sample(RTCStatsReport report, long observedNs) throws JSONException {
    RTCStats inbound = null;
    int matches = 0;
    for (RTCStats stat : report.getStatsMap().values()) {
      if ("inbound-rtp".equals(stat.getType()) && "video".equals(stat.getMembers().get("kind"))) {
        inbound = stat;
        matches++;
      }
    }
    long number = ++sequence;
    String state = matches == 0 ? "no_sample" : "ambiguous_stream";
    String label = matches == 0 ? "等待视频样本" : "多个视频流，统计不可用";
    Double windowMs = null, fps = null, kbps = null, decodeMs = null;
    Long receiverWindowNs = null;
    JSONObject raw = new JSONObject();
    String identity = null;
    if (matches == 1) {
      Map<String, Object> values = inbound.getMembers();
      identity = identity(inbound);
      for (String name : new String[] {"ssrc", "bytesReceived", "headerBytesReceived",
          "retransmittedBytesReceived", "packetsReceived", "packetsLost", "framesReceived",
          "framesDecoded", "framesDropped", "keyFramesDecoded", "framesPerSecond",
          "frameWidth", "frameHeight", "freezeCount", "totalFreezesDuration", "pauseCount",
          "totalPausesDuration", "totalDecodeTime", "jitter", "decoderImplementation",
          "powerEfficientDecoder", "codecId"}) {
        Object value = values.get(name);
        // Only known fields are recorded. Missing values remain JSON null, never fabricated zeroes.
        raw.put(name, value == null ? JSONObject.NULL : value);
      }
      raw.put("id", inbound.getId());
      raw.put("timestamp_us", inbound.getTimestampUs());
      RTCStats codec = report.getStatsMap().get(values.get("codecId"));
      raw.put("codecMimeType", codec == null ? JSONObject.NULL
          : codec.getMembers().getOrDefault("mimeType", JSONObject.NULL));
      Long bytes = counter(values, "bytesReceived"), frames = counter(values, "framesDecoded");
      if (bytes == null || frames == null || identity == null) {
        state = "unavailable"; label = "缺少有效计数，统计不可用";
        previous = null;
      } else {
        state = "baseline"; label = "首个样本，等待采样窗口";
        if (previous != null) {
          if (!identity.equals(identity(previous))) {
            state = "stream_changed"; label = "视频流已变化，重新采样";
          } else {
            receiverWindowNs = observedNs - previousObservedNs;
            double elapsedMs = receiverWindowNs / 1_000_000.0;
            windowMs = (inbound.getTimestampUs() - previous.getTimestampUs()) / 1000.0;
            Long oldBytes = counter(previous.getMembers(), "bytesReceived");
            Long oldFrames = counter(previous.getMembers(), "framesDecoded");
            if (!Double.isFinite(windowMs) || windowMs <= 0 || windowMs > 3000
                || elapsedMs <= 0 || elapsedMs > 3000
                || Math.abs(elapsedMs - windowMs) > Math.max(250, elapsedMs * .25)) {
              state = "sample_gap"; label = "采样间隔异常，重新采样";
            } else if (oldBytes == null || oldFrames == null || bytes < oldBytes || frames < oldFrames
                || decreased(values, previous.getMembers(), "framesReceived")
                || decreased(values, previous.getMembers(), "freezeCount")
                || decreased(values, previous.getMembers(), "totalDecodeTime")) {
              state = "counter_reset"; label = "计数已重置，重新采样";
            } else {
              fps = (frames - oldFrames) * 1000.0 / windowMs;
              kbps = (bytes - oldBytes) * 8.0 / windowMs;
              Double total = numeric(values.get("totalDecodeTime"));
              Double oldTotal = numeric(previous.getMembers().get("totalDecodeTime"));
              if (frames > oldFrames && total != null && oldTotal != null && total >= oldTotal) {
                decodeMs = (total - oldTotal) * 1000 / (frames - oldFrames);
              }
              state = frames.equals(oldFrames) ? "no_new_decoded_frames" : "sampled";
              label = frames.equals(oldFrames) ? "本窗无新解码帧" : "已采样";
            }
          }
        }
        previous = inbound;
        previousObservedNs = observedNs;
      }
    } else {
      previous = null;
    }
    String resolution = raw.isNull("frameWidth") || raw.isNull("frameHeight") ? "—"
        : raw.opt("frameWidth") + "×" + raw.opt("frameHeight");
    String freezes = raw.isNull("freezeCount") ? "—" : raw.opt("freezeCount").toString();
    String losses = raw.isNull("packetsLost") ? "—" : raw.opt("packetsLost").toString();
    String text = "视频统计 " + session.substring(0, 8) + " #" + number + " · " + label
        + " · 解码 " + format(fps) + " fps · 接收负载 " + format(kbps) + " kb/s"
        + "\n窗口 " + format(windowMs) + " ms · " + resolution
        + " · 库冻结累计 " + freezes + " · 丢包累计 " + losses;
    JSONObject record = new JSONObject();
    record.put("schema", 1).put("session", session).put("seq", number).put("state", state)
        .put("observed_elapsed_ns", observedNs)
        .put("receiver_observed_ns", Long.toString(observedNs))
        .put("receiver_window_ns", receiverWindowNs == null ? JSONObject.NULL : Long.toString(receiverWindowNs)).put("stream", identity == null ? JSONObject.NULL : identity)
        .put("window_ms", nullable(windowMs)).put("decoded_fps", nullable(fps))
        .put("received_payload_kbps", nullable(kbps)).put("mean_decode_ms", nullable(decodeMs))
        .put("raw", raw).put("ui", text);
    return new Sample(number, text, record.toString());
  }

  private static String identity(RTCStats stat) {
    Map<String, Object> values = stat.getMembers();
    if (counter(values, "ssrc") == null) return null;
    return stat.getId() + "/" + values.get("ssrc") + "/" + values.get("codecId");
  }

  private static Long counter(Map<String, Object> values, String name) {
    Double value = numeric(values.get(name));
    // Refuse integers outside exact double representation rather than silently lose a delta.
    return value == null || value < 0 || value > 9_007_199_254_740_991L || value != Math.rint(value)
        ? null : value.longValue();
  }

  private static Double numeric(Object value) {
    if (!(value instanceof Number)) return null;
    double number = ((Number) value).doubleValue();
    return Double.isFinite(number) ? number : null;
  }

  private static boolean decreased(Map<String, Object> current, Map<String, Object> before, String name) {
    Double value = numeric(current.get(name)), old = numeric(before.get(name));
    return value != null && old != null && value < old;
  }

  private static Object nullable(Double value) { return value == null ? JSONObject.NULL : value; }
  private static String format(Double value) {
    return value == null ? "—" : String.format(Locale.ROOT, "%.1f", value);
  }
}
