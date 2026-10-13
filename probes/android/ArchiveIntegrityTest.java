package dev.remotedesktop.probe;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Runs without Android; replays CRC corruption separately from receipt mismatches. */
public final class ArchiveIntegrityTest {
  interface Checked { void run() throws Exception; }
  static void rejected(String name, Checked check) throws Exception {
    try { check.run(); } catch (IOException expected) { return; }
    throw new AssertionError(name + " was accepted");
  }
  static ArchiveIntegrity.Receipt receipt(byte[] bytes) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256"); digest.update(bytes);
    return new ArchiveIntegrity.Receipt(bytes.length, digest);
  }
  public static void main(String[] args) throws Exception {
    byte[] payload = new byte[32768];
    for (int i=0;i<payload.length;i++) payload[i]=(byte)(i*37+11);
    ByteArrayOutputStream destination=new ByteArrayOutputStream();
    ArchiveIntegrity.Written written=new ArchiveIntegrity.Written(destination);
    try(ZipOutputStream zip=new ZipOutputStream(written)) {
      CRC32 crc=new CRC32();crc.update(payload);
      ZipEntry entry=new ZipEntry("experiment/frame.i420.zlib");entry.setMethod(ZipEntry.STORED);
      entry.setSize(payload.length);entry.setCrc(crc.getValue());zip.putNextEntry(entry);zip.write(payload);zip.closeEntry();
    }
    byte[] good=destination.toByteArray();
    ArchiveIntegrity.Receipt expected=written.receipt();
    expected.requireSame(receipt(good));
    expected.requireSame(ArchiveIntegrity.verify(new ByteArrayInputStream(good)));
    int data=30+(good[26]&255)+((good[27]&255)<<8)+(good[28]&255)+((good[29]&255)<<8);
    byte[] corrupt=good.clone();Arrays.fill(corrupt,data+1610,data+4096,(byte)0);
    // Even a matching whole-file hash must not make a ZIP with bad entry CRC pass.
    rejected("zero-filled payload with matching receipt",()->receipt(corrupt).requireSame(ArchiveIntegrity.verify(new ByteArrayInputStream(corrupt))));
    ByteArrayOutputStream multiple=new ByteArrayOutputStream();
    try(ZipOutputStream zip=new ZipOutputStream(multiple)) {
      for(int i=0;i<2;i++) {
        ZipEntry entry=new ZipEntry("frame-"+i);CRC32 crc=new CRC32();crc.update(payload);
        entry.setMethod(ZipEntry.STORED);entry.setSize(payload.length);entry.setCrc(crc.getValue());
        zip.putNextEntry(entry);zip.write(payload);zip.closeEntry();
      }
    }
    byte[] damagedLaterHeader=multiple.toByteArray();
    int nextHeader=30+"frame-0".length()+payload.length;
    damagedLaterHeader[nextHeader]=0;
    rejected("damaged later local header",()->ArchiveIntegrity.verify(new ByteArrayInputStream(damagedLaterHeader)));
    rejected("truncated entry",()->ArchiveIntegrity.verify(new ByteArrayInputStream(Arrays.copyOf(good,data+100))));
    byte[] missingTail=Arrays.copyOf(good,good.length-22);
    rejected("missing central-directory tail",()->expected.requireSame(ArchiveIntegrity.verify(new ByteArrayInputStream(missingTail))));
    byte[] changedDirectory=good.clone();changedDirectory[good.length-10]^=1;
    rejected("changed central directory",()->expected.requireSame(ArchiveIntegrity.verify(new ByteArrayInputStream(changedDirectory))));
    byte[] extra=Arrays.copyOf(good,good.length+1);
    rejected("appended bytes",()->expected.requireSame(ArchiveIntegrity.verify(new ByteArrayInputStream(extra))));
    expected.requireSame(ArchiveIntegrity.verify(new ByteArrayInputStream(good){@Override public synchronized int read(byte[] b,int off,int len){return super.read(b,off,Math.min(7,len));}}));
    rejected("read failure",()->ArchiveIntegrity.verify(new InputStream(){@Override public int read()throws IOException{throw new IOException("synthetic read failure");}}));
    rejected("unreadable destination",()->ArchiveIntegrity.verify(null));
    final boolean[] closed={false};
    ArchiveIntegrity.verify(new ByteArrayInputStream(good){@Override public void close(){closed[0]=true;}});
    if(!closed[0])throw new AssertionError("read stream leaked");
    final int[] forwarded={0,0,0};
    java.io.OutputStream owner=new java.io.OutputStream(){
      @Override public void write(int value){forwarded[0]++;}
      @Override public void write(byte[] b,int off,int len){forwarded[1]++;}
      @Override public void close(){forwarded[2]++;}
    };
    ArchiveIntegrity.Written counter=new ArchiveIntegrity.Written(owner);
    try(java.io.OutputStream borrowed=counter.borrowed()){borrowed.write(payload);}
    if(forwarded[0]!=0 || forwarded[1]!=1 || forwarded[2]!=0)
      throw new AssertionError("borrowed output must preserve bulk writes and owner lifetime");
    counter.close();
    if(forwarded[2]!=1)throw new AssertionError("owner not closed exactly once");
    Path durable=Files.createTempFile("archive-integrity-sync-", ".zip");
    try {
      ArchiveIntegrity.Receipt synced;
      java.io.FileDescriptor descriptor;
      try(java.io.FileOutputStream file=new java.io.FileOutputStream(durable.toFile())){
        descriptor=file.getFD();
        ArchiveIntegrity.Written bytes=new ArchiveIntegrity.Written(file);
        try(ZipOutputStream zip=new ZipOutputStream(bytes.borrowed())){
          zip.putNextEntry(new ZipEntry("frame"));zip.write(payload);zip.closeEntry();
        }
        if(!descriptor.valid())throw new AssertionError("ZIP closed file before sync");
        file.flush();descriptor.sync();synced=bytes.receipt();
      }
      if(descriptor.valid())throw new AssertionError("synced file descriptor leaked");
      synced.requireSame(ArchiveIntegrity.verify(Files.newInputStream(durable)));
    } finally {Files.delete(durable);}
    Path scratch=Files.createTempDirectory("archive-integrity-cleanup-");
    try {
      ArchiveIntegrity.verify(new ByteArrayInputStream(good),scratch.toFile());
      rejected("CRC failure cleanup",()->ArchiveIntegrity.verify(new ByteArrayInputStream(corrupt),scratch.toFile()));
      rejected("close failure",()->ArchiveIntegrity.verify(new ByteArrayInputStream(good){@Override public void close()throws IOException{throw new IOException("synthetic close failure");}},scratch.toFile()));
      try(java.util.stream.Stream<Path> remaining=Files.list(scratch)) {
        if(remaining.findAny().isPresent())throw new AssertionError("verification temporary file leaked");
      }
    } finally { Files.delete(scratch); }

    if(args.length>0){
      try(InputStream actual=Files.newInputStream(Path.of(args[0]))){
        System.out.println(ArchiveIntegrity.verify(actual).display());
      }
    }
    System.out.println("Archive integrity: CRC, full-file receipt, truncation, tail corruption, append, short reads, I/O failure and closure passed");
  }
}
