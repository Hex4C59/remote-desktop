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
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** One pinned TLS channel owns all SDP and trickle ICE for one media session. */
final class PairingConnection implements AutoCloseable {
  interface Listener { void onMessage(String message); void onClosed(); }
  private final ArrayBlockingQueue<String> outgoing = new ArrayBlockingQueue<>(128);
  private final Listener listener;
  private volatile SSLSocket socket;
  private volatile boolean closed;
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
  @Override public void close() {
    closed = true;
    SSLSocket current = socket;
    if (current != null) try { current.close(); } catch (IOException ignored) {}
    outgoing.clear();
  }
  private static void write(DataOutputStream output, String message) throws IOException {
    byte[] bytes = message.getBytes(StandardCharsets.UTF_8);
    output.writeInt(bytes.length); output.write(bytes); output.flush();
  }
  private void run(String address, String code) {
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
              throw new CertificateException("Pairing identity mismatch");
            }
          } catch (CertificateException error) { throw error; }
          catch (Exception error) { throw new CertificateException("Identity check failed"); }
        }
        @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
      };
      // The manually transferred code is the trust anchor, not a public CA or
      // an unverified IP hostname. Never fall back to an accepting trust manager.
      SSLContext context = SSLContext.getInstance("TLS");
      context.init(null, new TrustManager[] {pin}, null);
      String[] parts = address.trim().split(":", -1);
      if (parts.length > 2 || !parts[0].matches("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+")) throw new IOException("IPv4 required");
      int port = parts.length == 2 ? Integer.parseInt(parts[1]) : 18443;
      if (port < 1 || port > 65535) throw new IOException("Invalid port");
      socket = (SSLSocket) context.getSocketFactory().createSocket();
      if (closed) return;
      socket.setEnabledProtocols(new String[] {"TLSv1.2"});
      socket.connect(new InetSocketAddress(parts[0], port), 5000);
      socket.setSoTimeout(5000);
      socket.startHandshake();
      DataOutputStream output = new DataOutputStream(socket.getOutputStream());
      InputStream input = socket.getInputStream();
      write(output, "auth\n" + code);
      code = null;
      socket.setSoTimeout(100);
      byte[] header = new byte[4];
      byte[] body = null;
      int offset = 0;
      long lastReceived = System.nanoTime(), lastPing = lastReceived, frameStarted = 0;
      while (!closed) {
        String pending = outgoing.poll();
        if (pending != null) write(output, pending);
        long now = System.nanoTime();
        if (now - lastPing > 5_000_000_000L) { write(output, "ping"); lastPing = now; }
        if (now - lastReceived > 20_000_000_000L || (frameStarted != 0 && now - frameStarted > 5_000_000_000L)) break;
        byte[] target = body == null ? header : body;
        int count;
        try { count = input.read(target, offset, target.length - offset); }
        catch (SocketTimeoutException timeout) { continue; }
        if (count < 0) break;
        if (frameStarted == 0) frameStarted = System.nanoTime();
        offset += count;
        if (offset != target.length) continue;
        offset = 0;
        if (body == null) {
          int length = ByteBuffer.wrap(header).getInt();
          if (length < 1 || length > 65536) break;
          body = new byte[length];
        } else {
          String message = new String(body, StandardCharsets.UTF_8);
          body = null; frameStarted = 0; lastReceived = System.nanoTime();
          if (!message.equals("pong")) listener.onMessage(message);
        }
      }
    } catch (Exception error) {
      // Never log exceptions containing credentials, SDP, or peer-supplied text.
    } finally { close(); listener.onClosed(); }
  }
}
