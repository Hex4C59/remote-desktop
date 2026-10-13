package dev.remotedesktop.probe;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Enumeration;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipException;

/** ZIP CRC and whole-file receipts; owns and closes the streams it verifies. */
final class ArchiveIntegrity {
  static final class Receipt {
    final long bytes;
    final String sha256;
    Receipt(long bytes, MessageDigest digest) {
      this.bytes = bytes;
      StringBuilder hex = new StringBuilder(64);
      for (byte value : digest.digest()) {
        hex.append(Character.forDigit((value >>> 4) & 15, 16));
        hex.append(Character.forDigit(value & 15, 16));
      }
      sha256 = hex.toString();
    }
    void requireSame(Receipt other) throws IOException {
      if (bytes != other.bytes || !sha256.equals(other.sha256)) {
        throw new IOException("Archive readback differs from written bytes");
      }
    }
    String display() { return bytes + " bytes · SHA-256 " + sha256; }
  }

  static final class Written extends FilterOutputStream {
    private final MessageDigest digest = digest();
    private long bytes;
    Written(OutputStream output) { super(output); }
    @Override public void write(int value) throws IOException {
      out.write(value); digest.update((byte) value); bytes++;
    }
    @Override public void write(byte[] buffer, int offset, int length) throws IOException {
      out.write(buffer, offset, length); digest.update(buffer, offset, length); bytes += length;
    }
    // ZIP owns this wrapper; the caller retains the file until its descriptor is synced.
    OutputStream borrowed() {
      return new FilterOutputStream(this) {
        @Override public void write(byte[] buffer, int offset, int length) throws IOException {
          out.write(buffer, offset, length);
        }
        @Override public void close() throws IOException { flush(); }
      };
    }
    Receipt receipt() { return new Receipt(bytes, digest); }
  }

  static Receipt verify(InputStream input) throws IOException { return verify(input, null); }

  static Receipt verify(InputStream input, File temporaryDirectory) throws IOException {
    if (input == null) throw new IOException("Archive is not readable");
    File staged = null;
    try (InputStream source = input) {
      staged = File.createTempFile("software-archive-check-", ".zip", temporaryDirectory);
      Receipt receipt;
      byte[] buffer = new byte[64 * 1024];
      try (Written copy = new Written(new BufferedOutputStream(new FileOutputStream(staged), 64 * 1024))) {
        int count;
        while ((count = source.read(buffer)) != -1) copy.write(buffer, 0, count);
        copy.flush();
        receipt = copy.receipt();
      }
      // The central directory defines coverage: a damaged later local header must
      // not silently stop a streaming reader after only the earlier valid entries.
      try (ZipFile zip = new ZipFile(staged)) {
        Enumeration<? extends ZipEntry> entries = zip.entries();
        int checked = 0;
        while (entries.hasMoreElements()) {
          ZipEntry entry = entries.nextElement();
          CRC32 crc = new CRC32();
          long bytes = 0;
          try (InputStream contents = zip.getInputStream(entry)) {
            int count;
            while ((count = contents.read(buffer)) != -1) {
              crc.update(buffer, 0, count);
              bytes += count;
            }
          }
          if (crc.getValue() != entry.getCrc() || bytes != entry.getSize()) {
            throw new ZipException("Archive entry CRC or size mismatch");
          }
          checked++;
        }
        if (checked == 0) throw new ZipException("Archive has no entries");
      }
      return receipt;
    } finally {
      if (staged != null && staged.exists() && !staged.delete()) {
        throw new IOException("Cannot remove owned archive verification temporary file");
      }
    }
  }

  private static MessageDigest digest() {
    try { return MessageDigest.getInstance("SHA-256"); }
    catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
  }
}
