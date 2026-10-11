package dev.remotedesktop.probe;

import android.util.Base64;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.CertificateExpiredException;
import java.security.cert.CertificateNotYetValidException;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** One pinned TLS channel owns all SDP and trickle ICE for one media session. */
final class PairingConnection implements AutoCloseable {
  enum Failure {
    CLOSED("连接已结束；请重新连接"),
    INVALID_CODE("配对口令格式错误；请完整输入电脑显示的口令"),
    INVALID_ADDRESS("电脑地址格式错误；请输入 IPv4 地址和端口"),
    CONNECT_TIMEOUT("连接电脑超时；请检查两端 Wi-Fi、地址和防火墙"),
    CONNECT_FAILED("无法连接电脑；请检查两端 Wi-Fi、地址和被控端程序"),
    CERTIFICATE_TIME("电脑身份的有效期校验失败；请核对电脑和平板的系统日期与时间，再生成新口令"),
    IDENTITY_MISMATCH("临时口令与电脑身份不匹配；请重新输入当前口令"),
    TLS_FAILED("电脑身份校验或安全连接失败；请重新生成口令后重试"),
    TRANSPORT_TIMEOUT("电脑响应超时；请检查网络后重新连接"),
    PROTOCOL_FAILED("电脑返回的连接数据无效；请结束后重新连接"),
    TRANSPORT_FAILED("连接传输失败；请检查网络后重新连接");
    final String message;
    Failure(String message) { this.message = message; }
  }
  private enum Phase { CODE, ADDRESS, TLS_SETUP, CONNECT, HANDSHAKE, EXCHANGE }
  private static final class IdentityMismatch extends CertificateException {}
  interface Listener { void onMessage(String message); void onClosed(Failure reason); }
  private final ArrayBlockingQueue<String> outgoing = new ArrayBlockingQueue<>(128);
  private final Listener listener;
  private volatile SSLSocket socket;
  private volatile boolean closed;
  private volatile Failure endReason = Failure.CLOSED;
  private volatile long lastReceived;
  PairingConnection(Listener listener) { this.listener = listener; }
  void start(String address, String code) {
    new Thread(() -> run(address, code), "pairing-tls").start();
  }
  boolean send(String message) {
    if (closed || message.getBytes(StandardCharsets.UTF_8).length > 65536 || !outgoing.offer(message)) {
      close(); return false;
    }
    return true;
  }
  private synchronized void fail(Failure reason) {
    if (closed) return;
    endReason = reason;
    close();
  }
  @Override public synchronized void close() {
    closed = true;
    SSLSocket current = socket;
    if (current != null) try { current.close(); } catch (IOException ignored) {}
    outgoing.clear();
  }
  private static void write(DataOutputStream output, String message) throws IOException {
    byte[] bytes = message.getBytes(StandardCharsets.UTF_8);
    output.writeInt(bytes.length); output.write(bytes); output.flush();
  }
  private static Failure classify(Exception error, Phase phase) {
    // Inspect types only. Exception messages may contain credentials or peer data.
    Throwable cause = error;
    for (int depth = 0; cause != null && depth < 16; depth++, cause = cause.getCause()) {
      if (cause instanceof CertificateExpiredException || cause instanceof CertificateNotYetValidException) {
        return Failure.CERTIFICATE_TIME;
      }
      if (cause instanceof IdentityMismatch) return Failure.IDENTITY_MISMATCH;
    }
    if (phase == Phase.CODE) return Failure.INVALID_CODE;
    if (phase == Phase.ADDRESS) return Failure.INVALID_ADDRESS;
    if (phase == Phase.CONNECT) return error instanceof SocketTimeoutException
        ? Failure.CONNECT_TIMEOUT : Failure.CONNECT_FAILED;
    if (phase == Phase.TLS_SETUP || phase == Phase.HANDSHAKE) return Failure.TLS_FAILED;
    return Failure.TRANSPORT_FAILED;
  }
  private void run(String address, String code) {
    Phase phase = Phase.CODE;
    try {
      if (!code.matches("[A-Za-z0-9_-]{64}")) throw new IOException("Invalid code format");
      byte[] decoded = Base64.decode(code, Base64.URL_SAFE | Base64.NO_WRAP);
      if (decoded.length != 48) throw new IOException("Invalid code size");
      byte[] fingerprint = Arrays.copyOf(decoded, 32);
      Arrays.fill(decoded, (byte) 0);
      TrustManager pin = new X509TrustManager() {
        @Override public void checkClientTrusted(X509Certificate[] chain, String type) throws CertificateException {
          throw new CertificateException("Client certificates unsupported");
        }
        @Override public void checkServerTrusted(X509Certificate[] chain, String type) throws CertificateException {
          try {
            if (chain.length != 1) throw new CertificateException("Expected ephemeral identity");
            chain[0].checkValidity();
            if (!MessageDigest.isEqual(fingerprint, MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded()))) {
              throw new IdentityMismatch();
            }
          } catch (CertificateException error) { throw error; }
          catch (Exception error) { throw new CertificateException("Identity check failed"); }
        }
        @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
      };
      // The manually transferred code is the trust anchor, not a public CA or
      // an unverified IP hostname. Never fall back to an accepting trust manager.
      phase = Phase.TLS_SETUP;
      SSLContext context = SSLContext.getInstance("TLS");
      context.init(null, new TrustManager[] {pin}, null);
      phase = Phase.ADDRESS;
      String[] parts = address.trim().split(":", -1);
      if (parts.length > 2 || !parts[0].matches("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+")) throw new IOException("IPv4 required");
      int port = parts.length == 2 ? Integer.parseInt(parts[1]) : 18443;
      if (port < 1 || port > 65535) throw new IOException("Invalid port");
      phase = Phase.TLS_SETUP;
      socket = (SSLSocket) context.getSocketFactory().createSocket();
      if (closed) return;
      socket.setEnabledProtocols(new String[] {"TLSv1.2"});
      phase = Phase.CONNECT;
      socket.connect(new InetSocketAddress(parts[0], port), 5000);
      socket.setSoTimeout(5000);
      phase = Phase.HANDSHAKE;
      socket.startHandshake();
      phase = Phase.EXCHANGE;
      lastReceived = System.nanoTime();
      // SO_TIMEOUT only bounds reads. A separate watchdog also closes a blocked
      // TLS write on a dead link; there is no reconnect or keepalive service.
      Thread watchdog = new Thread(() -> {
        while (!closed) {
          if (System.nanoTime() - lastReceived > 20_000_000_000L) { fail(Failure.TRANSPORT_TIMEOUT); break; }
          try { Thread.sleep(100); }
          catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); break; }
        }
      }, "pairing-deadline");
      watchdog.start();
      DataOutputStream output = new DataOutputStream(socket.getOutputStream());
      InputStream input = socket.getInputStream();
      write(output, "auth\n" + code);
      code = null;
      socket.setSoTimeout(100);
      byte[] header = new byte[4];
      byte[] body = null;
      int offset = 0;
      long lastPing = lastReceived, frameStarted = 0;
      while (!closed) {
        String pending = outgoing.poll();
        if (pending != null) write(output, pending);
        long now = System.nanoTime();
        if (now - lastPing > 5_000_000_000L) { write(output, "ping"); lastPing = now; }
        if (now - lastReceived > 20_000_000_000L || (frameStarted != 0 && now - frameStarted > 5_000_000_000L)) { fail(Failure.TRANSPORT_TIMEOUT); break; }
        byte[] target = body == null ? header : body;
        int count;
        try { count = input.read(target, offset, target.length - offset); }
        catch (SocketTimeoutException timeout) { continue; }
        if (count < 0) { fail(Failure.TRANSPORT_FAILED); break; }
        if (frameStarted == 0) frameStarted = System.nanoTime();
        offset += count;
        if (offset != target.length) continue;
        offset = 0;
        if (body == null) {
          int length = ByteBuffer.wrap(header).getInt();
          if (length < 1 || length > 65536) { fail(Failure.PROTOCOL_FAILED); break; }
          body = new byte[length];
        } else {
          String message = new String(body, StandardCharsets.UTF_8);
          body = null; frameStarted = 0; lastReceived = System.nanoTime();
          if (!message.equals("pong")) listener.onMessage(message);
        }
      }
    } catch (Exception error) {
      fail(classify(error, phase));
    } finally { close(); listener.onClosed(endReason); }
  }
}
