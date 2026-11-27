// 职责：帧池与单槽移交的单元测试（规格 FH-01/02/06/07/08/23）。
// Thread: none（单线程用例；并发用例 FH-12/18/20 在后续批次加入）。

#include <gtest/gtest.h>

#include <cstddef>
#include <cstdint>
#include <span>

#include <remotedesktop/frame_handoff.h>

namespace {
  constexpr std::uint32_t kWidth = 4;
  constexpr std::uint32_t kHeight = 3;
  constexpr std::uint32_t kStride = 16;    // 4 像素 * 4 字节
  constexpr std::size_t kFrameBytes = 64;  // 4 * 3 * 4 = 48，留余量

  rd::FrameDesc MakeDesc(std::uint64_t timestamp_ns) {
    rd::FrameDesc desc;
    desc.width = kWidth;
    desc.height = kHeight;
    desc.stride = kStride;
    desc.format = rd::PixelFormat::kBGRA8;
    desc.capture_timestamp_ns = timestamp_ns;
    desc.display_map_version = 7;
    return desc;
  }

  // 取得一帧并写好 desc 与首字节；所有权归调用方。
  rd::Frame* AcquireFilled(rd::FramePool& pool, std::uint64_t timestamp_ns) {
    rd::Frame* frame = pool.try_acquire_free();
    if (frame == nullptr) return nullptr;
    rd::FrameDesc* desc = frame->mutable_desc();
    if (desc == nullptr) {
      frame->release();
      return nullptr;
    }
    *desc = MakeDesc(timestamp_ns);
    frame->mutable_pixels()[0] = std::byte{0xAB};
    return frame;
  }
}  // namespace

// FH-01：空槽 try_acquire() 返回 nullptr，池计数不变。
TEST(FrameSlotTest, EmptySlotReturnsNullAndKeepsCounts) {
  rd::FramePool pool(2, kFrameBytes);
  rd::FrameSlot slot;

  EXPECT_EQ(slot.try_acquire(), nullptr);
  EXPECT_EQ(pool.in_use(), 0u);
  EXPECT_EQ(pool.free_count(), 2u);
}

// FH-02：publish 后取得同一帧，desc 逐字段相等，pixels().size() == stride *
// height。
TEST(FrameSlotTest, PublishedFrameKeepsDescAndPixelSize) {
  rd::FramePool pool(2, kFrameBytes);
  rd::FrameSlot slot;
  rd::Frame* frame = AcquireFilled(pool, 1234);
  ASSERT_NE(frame, nullptr);
  const rd::FrameDesc expected = *frame->mutable_desc();

  slot.publish(frame);
  rd::Frame* got = slot.try_acquire();
  ASSERT_EQ(got, frame);
  EXPECT_EQ(got->desc().width, expected.width);
  EXPECT_EQ(got->desc().height, expected.height);
  EXPECT_EQ(got->desc().stride, expected.stride);
  EXPECT_EQ(got->desc().format, expected.format);
  EXPECT_EQ(got->desc().capture_timestamp_ns, expected.capture_timestamp_ns);
  EXPECT_EQ(got->desc().display_map_version, expected.display_map_version);
  EXPECT_EQ(got->pixels().size(),
            std::size_t{expected.stride} * expected.height);
  EXPECT_EQ(got->pixels()[0], std::byte{0xAB});

  got->release();
  EXPECT_EQ(pool.in_use(), 0u);
}

// FH-06：publish(nullptr) 是无操作，槽内容与计数都不变。
TEST(FrameSlotTest, PublishNullIsNoOp) {
  rd::FramePool pool(1, kFrameBytes);
  rd::FrameSlot slot;

  slot.publish(nullptr);  // 空槽
  EXPECT_EQ(slot.try_acquire(), nullptr);

  rd::Frame* frame = pool.try_acquire_free();
  ASSERT_NE(frame, nullptr);
  slot.publish(frame);
  slot.publish(nullptr);  // 槽内有帧

  EXPECT_EQ(pool.in_use(), 1u);
  EXPECT_EQ(slot.try_acquire(), frame);
  frame->release();
  EXPECT_EQ(pool.in_use(), 0u);
}

// FH-07：池耗尽后返回 nullptr，不阻塞、不分配、计数不变。
TEST(FramePoolTest, ExhaustedPoolReturnsNull) {
  rd::FramePool pool(2, kFrameBytes);
  rd::Frame* first = pool.try_acquire_free();
  rd::Frame* second = pool.try_acquire_free();
  ASSERT_NE(first, nullptr);
  ASSERT_NE(second, nullptr);
  EXPECT_NE(first, second);
  EXPECT_EQ(pool.in_use(), 2u);
  EXPECT_EQ(pool.free_count(), 0u);

  EXPECT_EQ(pool.try_acquire_free(), nullptr);
  EXPECT_EQ(pool.in_use(), 2u);
  EXPECT_EQ(pool.free_count(), 0u);

  first->release();
  second->release();
}

// FH-08：全部 release 后池恢复满容量。
TEST(FramePoolTest, ReleasingAllRestoresCapacity) {
  rd::FramePool pool(3, kFrameBytes);
  rd::Frame* frames[3] = {};
  for (auto& frame : frames) {
    frame = pool.try_acquire_free();
    ASSERT_NE(frame, nullptr);
  }
  EXPECT_EQ(pool.in_use(), 3u);
  EXPECT_EQ(pool.free_count(), 0u);

  for (auto* frame : frames) frame->release();

  EXPECT_EQ(pool.in_use(), 0u);
  EXPECT_EQ(pool.free_count(), 3u);
}

// FH-08, FH-23: each lease starts writable and owns one reference.
TEST(FramePoolTest, ReacquiredPublishedFrameResetsOwnership) {
  rd::FramePool pool(1, kFrameBytes);
  rd::FrameSlot slot;
  auto* first = pool.try_acquire_free();
  ASSERT_NE(first, nullptr);
  slot.publish(first);
  auto* published = slot.try_acquire();
  ASSERT_EQ(published, first);
  published->release();
  ASSERT_EQ(pool.free_count(), 1u);

  auto* reused = pool.try_acquire_free();
  ASSERT_EQ(reused, first);
  EXPECT_NE(reused->mutable_desc(), nullptr);
  EXPECT_EQ(reused->mutable_pixels().size(), kFrameBytes);
  reused->release();
  EXPECT_EQ(pool.in_use(), 0u);
  EXPECT_EQ(pool.free_count(), 1u);
}

// FH-23：发布前可写，缓冲长度为 frame_bytes。
TEST(FrameWriteViewTest, WritableBeforePublish) {
  rd::FramePool pool(1, kFrameBytes);
  rd::Frame* frame = pool.try_acquire_free();
  ASSERT_NE(frame, nullptr);

  EXPECT_NE(frame->mutable_desc(), nullptr);
  EXPECT_EQ(frame->mutable_pixels().size(), kFrameBytes);

  frame->release();
}

#if defined(NDEBUG)

// FH-23（Release）：发布后写入视图关闭，返回 nullptr / 空 span。
TEST(FrameWriteViewTest, ClosedAfterPublishInRelease) {
  rd::FramePool pool(1, kFrameBytes);
  rd::FrameSlot slot;
  rd::Frame* frame = pool.try_acquire_free();
  ASSERT_NE(frame, nullptr);
  slot.publish(frame);

  EXPECT_EQ(frame->mutable_desc(), nullptr);
  EXPECT_TRUE(frame->mutable_pixels().empty());

  rd::Frame* got = slot.try_acquire();
  ASSERT_EQ(got, frame);
  got->release();
}

#else

// FH-23（Debug）：发布后写入视图触发 RD_ASSERT。
TEST(FrameWriteViewTest, ClosedAfterPublishAbortsInDebug) {
  rd::FramePool pool(1, kFrameBytes);
  rd::FrameSlot slot;
  rd::Frame* frame = pool.try_acquire_free();
  ASSERT_NE(frame, nullptr);
  slot.publish(frame);

  EXPECT_DEATH(frame->mutable_desc(), "RD_ASSERT");

  rd::Frame* got = slot.try_acquire();
  ASSERT_EQ(got, frame);
  got->release();
}

#endif  // defined(NDEBUG)
