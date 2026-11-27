// PW-09–19 and PW-21 through scripted input backends.
// Thread: none
#include <array>
#include <optional>
#include <set>
#include <span>
#include <string>
#include <vector>

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include "remotedesktop/platform/win/input_inject_win.h"

namespace rd::platform::win {
  namespace {
    using ::testing::ElementsAre;
    using ::testing::InSequence;
    using ::testing::Return;
    using ::testing::VariantWith;

    class MockInputPressBackend : public InputPressBackend {
     public:
      MOCK_METHOD(InputBatchResult, submit, (std::span<const PressChange>), (noexcept, override));
      MOCK_METHOD(DesktopState, desktop_state, (), (const, noexcept, override));
    };

    class PressLedgerTest : public ::testing::Test {
     protected:
      void SetUp() override {
        ON_CALL(backend_, desktop_state()).WillByDefault(Return(DesktopState::kInteractive));
      }

      void press_key(Key key) {
        EXPECT_CALL(backend_, submit(ElementsAre(PressChange{key, PressAction::kDown})))
            .WillOnce(Return(InputBatchResult{1, true}));
        InputEvent event{.kind = InputKind::kKeyDown, .key = key, .text = {}};
        EXPECT_THAT(injector_.inject(event), VariantWith<std::monostate>(std::monostate{}));
      }

      void expect_release(PressIdentity identity, InputBatchResult result) {
        EXPECT_CALL(backend_, submit(ElementsAre(PressChange{identity, PressAction::kUp})))
            .WillOnce(Return(result));
      }

      ::testing::NiceMock<MockInputPressBackend> backend_;
      InputInjectorWin injector_{backend_};
    };

    TEST_F(PressLedgerTest, Pw18RejectedKeyUpKeepsAcceptedKeyDown) {
      const InSequence sequence;
      press_key(Key::kA);
      expect_release(Key::kA, {0, true});
      InputEvent event{.kind = InputKind::kKeyUp, .key = Key::kA, .text = {}};
      EXPECT_THAT(injector_.inject(event), VariantWith<PlatformError>(PlatformError::kInternal));
      EXPECT_EQ(injector_.pressed_count(), 1U);

      expect_release(Key::kA, {1, true});
      EXPECT_THAT(injector_.release_all_pressed(), VariantWith<std::monostate>(std::monostate{}));
      EXPECT_EQ(injector_.pressed_count(), 0U);
    }

    TEST_F(PressLedgerTest, Pw18ConfirmedPrefixKeepsOnlyUnreleasedCodeUnit) {
      const InSequence sequence;
      EXPECT_CALL(backend_, submit(ElementsAre(PressChange{u'A', PressAction::kDown},
                                               PressChange{u'A', PressAction::kUp},
                                               PressChange{u'B', PressAction::kDown},
                                               PressChange{u'B', PressAction::kUp})))
          .WillOnce(Return(InputBatchResult{3, true}));
      InputEvent event{.kind = InputKind::kText, .text = "AB"};
      EXPECT_THAT(injector_.inject(event), VariantWith<PlatformError>(PlatformError::kInternal));
      EXPECT_EQ(injector_.pressed_count(), 1U);

      expect_release(u'B', {1, true});
      EXPECT_THAT(injector_.release_all_pressed(), VariantWith<std::monostate>(std::monostate{}));
    }

    TEST_F(PressLedgerTest, Pw18UnattributedPartialBatchKeepsPossiblePresses) {
      const InSequence sequence;
      EXPECT_CALL(backend_, submit(ElementsAre(PressChange{u'A', PressAction::kDown},
                                               PressChange{u'A', PressAction::kUp},
                                               PressChange{u'B', PressAction::kDown},
                                               PressChange{u'B', PressAction::kUp})))
          .WillOnce(Return(InputBatchResult{2, false}));
      InputEvent event{.kind = InputKind::kText, .text = "AB"};
      EXPECT_THAT(injector_.inject(event), VariantWith<PlatformError>(PlatformError::kInternal));
      EXPECT_EQ(injector_.pressed_count(), 2U);

      expect_release(u'B', {1, true});
      expect_release(u'A', {1, true});
      EXPECT_THAT(injector_.release_all_pressed(), VariantWith<std::monostate>(std::monostate{}));
    }

    TEST_F(PressLedgerTest, Pw21RetrySkipsConfirmedReleasesAndKeepsModifierLast) {
      const InSequence sequence;
      press_key(Key::kLeftCtrl);
      press_key(Key::kA);
      EXPECT_CALL(backend_, submit(ElementsAre(PressChange{MouseButton::kLeft, PressAction::kDown})))
          .WillOnce(Return(InputBatchResult{1, true}));
      InputEvent button{.kind = InputKind::kButtonDown, .button = MouseButton::kLeft, .text = {}};
      EXPECT_THAT(injector_.inject(button), VariantWith<std::monostate>(std::monostate{}));

      expect_release(MouseButton::kLeft, {1, true});
      expect_release(Key::kA, {0, true});
      EXPECT_THAT(injector_.release_all_pressed(),
                  VariantWith<PlatformError>(PlatformError::kInputCleanupPending));
      EXPECT_EQ(injector_.pressed_count(), 2U);

      expect_release(Key::kA, {0, false});
      EXPECT_THAT(injector_.release_all_pressed(),
                  VariantWith<PlatformError>(PlatformError::kInputCleanupPending));
      EXPECT_EQ(injector_.pressed_count(), 2U);

      expect_release(Key::kA, {1, true});
      expect_release(Key::kLeftCtrl, {1, true});
      EXPECT_THAT(injector_.release_all_pressed(), VariantWith<std::monostate>(std::monostate{}));
      EXPECT_EQ(injector_.pressed_count(), 0U);
      EXPECT_THAT(injector_.release_all_pressed(), VariantWith<std::monostate>(std::monostate{}));
    }

    TEST_F(PressLedgerTest, Pw21LockedDesktopKeepsUnconfirmedPressUntilRecovery) {
      const InSequence sequence;
      press_key(Key::kA);
      ON_CALL(backend_, desktop_state()).WillByDefault(Return(DesktopState::kLocked));
      auto release = ElementsAre(PressChange{Key::kA, PressAction::kUp});
      EXPECT_CALL(backend_, submit(release)).Times(::testing::AtMost(1))
          .WillRepeatedly(Return(InputBatchResult{0, true}));
      EXPECT_THAT(injector_.release_all_pressed(),
                  VariantWith<PlatformError>(PlatformError::kInputCleanupPending));
      EXPECT_EQ(injector_.pressed_count(), 1U);

      ON_CALL(backend_, desktop_state()).WillByDefault(Return(DesktopState::kInteractive));
      expect_release(Key::kA, {1, true});
      EXPECT_THAT(injector_.release_all_pressed(), VariantWith<std::monostate>(std::monostate{}));
      EXPECT_EQ(injector_.pressed_count(), 0U);
    }
    struct RecordingInputSystem {
      InputSystemWin callbacks() noexcept { return {submit, bounds, this}; }
      DesktopStateReader desktop() const noexcept { return {state, this}; }

      static std::size_t submit(void* context,
                                std::span<const InputPacket> packets) noexcept {
        auto& self = *static_cast<RecordingInputSystem*>(context);
        self.batches.emplace_back(packets.begin(), packets.end());
        return self.accepted.value_or(packets.size());
      }

      static VirtualDesktopBounds bounds(void* context) noexcept {
        return static_cast<RecordingInputSystem*>(context)->geometry;
      }

      static DesktopState state(const void* context) noexcept {
        return static_cast<const RecordingInputSystem*>(context)->state_value;
      }

      VirtualDesktopBounds geometry{-160, 40, 320, 200};
      DesktopState state_value{DesktopState::kInteractive};
      std::optional<std::size_t> accepted;
      std::vector<std::vector<InputPacket>> batches;
    };

    class InputPacketsTest : public ::testing::Test {
     protected:
      void TearDown() override {
        system_.accepted.reset();
        system_.state_value = DesktopState::kInteractive;
        EXPECT_THAT(injector_.release_all_pressed(),
                    VariantWith<std::monostate>(std::monostate{}));
      }

      PlatformResult<void> press_key(Key key) {
        InputEvent event{.kind = InputKind::kKeyDown, .key = key, .text = {}};
        const auto result = injector_.inject(event);
        EXPECT_GT(event.inject_timestamp_ns, 0U);
        return result;
      }

      void destroy_with_pressed_key() {
        InputInjectorWin injector{system_.callbacks(), system_.desktop()};
        InputEvent event{
            .kind = InputKind::kKeyDown, .key = Key::kA, .text = {}};
        static_cast<void>(injector.inject(event));
      }

      RecordingInputSystem system_;
      InputInjectorWin injector_{system_.callbacks(), system_.desktop()};
    };

    TEST_F(InputPacketsTest,
           Pw09PointerMoveUsesAbsoluteVirtualDesktopCoordinates) {
      InputEvent move{.x = 0, .y = 140, .text = {}, .source_timestamp_ns = 37};
      EXPECT_THAT(injector_.inject(move),
                  VariantWith<std::monostate>(std::monostate{}));
      EXPECT_GT(move.inject_timestamp_ns, 0U);
      EXPECT_EQ(move.source_timestamp_ns, 37U);
      ASSERT_EQ(system_.batches.size(), 1U);
      EXPECT_THAT(
          system_.batches.front(),
          ElementsAre(InputPacket{.flags = 0xc001, .x = 32768, .y = 32768}));

      move.x = 159;
      move.y = 239;
      EXPECT_THAT(injector_.inject(move),
                  VariantWith<std::monostate>(std::monostate{}));
      ASSERT_EQ(system_.batches.size(), 2U);
      EXPECT_THAT(
          system_.batches.back(),
          ElementsAre(InputPacket{.flags = 0xc001, .x = 65535, .y = 65535}));

      move.x = 160;
      EXPECT_THAT(injector_.inject(move),
                  VariantWith<PlatformError>(PlatformError::kInvalidArgument));
      EXPECT_EQ(system_.batches.size(), 2U);
      EXPECT_EQ(injector_.pressed_count(), 0U);
    }

    TEST_F(InputPacketsTest, WheelKeepsSignedDeltaWithoutRecordingAPress) {
      InputEvent wheel{
          .kind = InputKind::kWheel, .wheel_delta = -120, .text = {}};
      EXPECT_THAT(injector_.inject(wheel),
                  VariantWith<std::monostate>(std::monostate{}));
      EXPECT_GT(wheel.inject_timestamp_ns, 0U);
      ASSERT_EQ(system_.batches.size(), 1U);
      EXPECT_THAT(
          system_.batches.front(),
          ElementsAre(InputPacket{.flags = 0x0800, .wheel_delta = -120}));
      EXPECT_EQ(injector_.pressed_count(), 0U);
    }

    TEST_F(InputPacketsTest, Pw10EachMouseButtonIsRecordedAndReleased) {
      constexpr std::array buttons{MouseButton::kLeft, MouseButton::kRight,
                                   MouseButton::kMiddle};
      constexpr std::array<std::uint32_t, 3> down_flags{0x0002, 0x0008, 0x0020};
      constexpr std::array<std::uint32_t, 3> up_flags{0x0004, 0x0010, 0x0040};
      for (std::size_t i = 0; i < buttons.size(); ++i) {
        SCOPED_TRACE(i);
        InputEvent button{
            .kind = InputKind::kButtonDown, .button = buttons[i], .text = {}};
        EXPECT_THAT(injector_.inject(button),
                    VariantWith<std::monostate>(std::monostate{}));
        EXPECT_GT(button.inject_timestamp_ns, 0U);
        EXPECT_EQ(injector_.pressed_count(), 1U);
        EXPECT_THAT(injector_.release_all_pressed(),
                    VariantWith<std::monostate>(std::monostate{}));
        EXPECT_EQ(injector_.pressed_count(), 0U);
        ASSERT_EQ(system_.batches.size(), 2U);
        EXPECT_THAT(system_.batches[0],
                    ElementsAre(InputPacket{.flags = down_flags[i]}));
        EXPECT_THAT(system_.batches[1],
                    ElementsAre(InputPacket{.flags = up_flags[i]}));
        system_.batches.clear();
      }
    }

    TEST_F(InputPacketsTest, Pw11LedgerReleasesPhysicalKeysInReverseOrder) {
      EXPECT_THAT(press_key(Key::kA),
                  VariantWith<std::monostate>(std::monostate{}));
      EXPECT_THAT(press_key(Key::kArrowRight),
                  VariantWith<std::monostate>(std::monostate{}));
      EXPECT_EQ(injector_.pressed_count(), 2U);
      EXPECT_THAT(injector_.release_all_pressed(),
                  VariantWith<std::monostate>(std::monostate{}));
      EXPECT_EQ(injector_.pressed_count(), 0U);
      ASSERT_EQ(system_.batches.size(), 4U);
      EXPECT_THAT(system_.batches[2],
                  ElementsAre(InputPacket{.kind = InputPacketKind::kKeyboard,
                                          .flags = 3,
                                          .virtual_key = 0x27}));
      EXPECT_THAT(system_.batches[3],
                  ElementsAre(InputPacket{.kind = InputPacketKind::kKeyboard,
                                          .flags = 2,
                                          .virtual_key = 0x41}));
    }

    TEST_F(InputPacketsTest, Pw12EmptyLedgerReleasesNothing) {
      for (int attempt = 0; attempt < 2; ++attempt) {
        EXPECT_THAT(injector_.release_all_pressed(),
                    VariantWith<std::monostate>(std::monostate{}));
      }
      EXPECT_EQ(injector_.pressed_count(), 0U);
      EXPECT_TRUE(system_.batches.empty());
    }

    TEST_F(InputPacketsTest, Pw13DuplicateKeyDownDoesNotDispatchAgain) {
      ASSERT_THAT(press_key(Key::kA),
                  VariantWith<std::monostate>(std::monostate{}));
#ifndef NDEBUG
      EXPECT_DEATH(static_cast<void>(press_key(Key::kA)),
                   "duplicate key press");
#else
      EXPECT_THAT(press_key(Key::kA),
                  VariantWith<PlatformError>(PlatformError::kInternal));
#endif
      EXPECT_EQ(system_.batches.size(), 1U);
      EXPECT_EQ(injector_.pressed_count(), 1U);
    }

    TEST_F(InputPacketsTest, Pw14RejectsInvalidTextWithoutDispatchingAPrefix) {
      const std::string too_long(257, 'a');
      for (const auto text :
           {std::string_view{"A\xc3\xa9"}, std::string_view{"A\n"},
            std::string_view{too_long}}) {
        InputEvent event{.kind = InputKind::kText, .text = text};
        EXPECT_THAT(injector_.inject(event),
                    VariantWith<PlatformError>(PlatformError::kNotSupported));
        EXPECT_GT(event.inject_timestamp_ns, 0U);
      }
      EXPECT_TRUE(system_.batches.empty());
      EXPECT_EQ(injector_.pressed_count(), 0U);
    }

    TEST_F(InputPacketsTest, Pw15TextDispatchesUnicodePairsAndLeavesNoPresses) {
      InputEvent event{.kind = InputKind::kText, .text = "A ~"};
      EXPECT_THAT(injector_.inject(event),
                  VariantWith<std::monostate>(std::monostate{}));
      EXPECT_GT(event.inject_timestamp_ns, 0U);
      EXPECT_EQ(injector_.pressed_count(), 0U);
      ASSERT_EQ(system_.batches.size(), 1U);
      EXPECT_THAT(system_.batches.front(),
                  ElementsAre(InputPacket{.kind = InputPacketKind::kKeyboard,
                                          .flags = 4,
                                          .scan_code = u'A'},
                              InputPacket{.kind = InputPacketKind::kKeyboard,
                                          .flags = 6,
                                          .scan_code = u'A'},
                              InputPacket{.kind = InputPacketKind::kKeyboard,
                                          .flags = 4,
                                          .scan_code = u' '},
                              InputPacket{.kind = InputPacketKind::kKeyboard,
                                          .flags = 6,
                                          .scan_code = u' '},
                              InputPacket{.kind = InputPacketKind::kKeyboard,
                                          .flags = 4,
                                          .scan_code = u'~'},
                              InputPacket{.kind = InputPacketKind::kKeyboard,
                                          .flags = 6,
                                          .scan_code = u'~'}));
      const std::string max_length(256, 'z');
      event.text = max_length;
      EXPECT_THAT(injector_.inject(event),
                  VariantWith<std::monostate>(std::monostate{}));
      ASSERT_EQ(system_.batches.size(), 2U);
      EXPECT_EQ(system_.batches.back().size(), 512U);
      EXPECT_EQ(injector_.pressed_count(), 0U);
    }

    TEST_F(InputPacketsTest,
           Pw16EveryPhysicalKeyHasTheExpectedUniqueVirtualKey) {
      constexpr std::array<std::uint16_t, 35> other_keys{
          0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c, 0x1b,
          0x09, 0x14, 0x20, 0x0d, 0x08, 0x2e, 0x2d, 0x24, 0x23,
          0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0xbd, 0xbb, 0xdb,
          0xdd, 0xdc, 0xba, 0xde, 0xbc, 0xbe, 0xbf, 0xc0};
      const auto key_number = [](Key key) {
        return static_cast<std::uint16_t>(key);
      };
      std::set<std::uint16_t> mapped;
      for (auto index = key_number(Key::kA); index < key_number(Key::kCount);
           ++index) {
        SCOPED_TRACE(index);
        const auto key = static_cast<Key>(index);
        std::uint16_t expected = 0;
        if (key <= Key::kZ) {
          expected =
              static_cast<std::uint16_t>(0x41 + index - key_number(Key::kA));
        } else if (key <= Key::k9) {
          expected =
              static_cast<std::uint16_t>(0x30 + index - key_number(Key::k0));
        } else if (key <= Key::kF12) {
          expected =
              static_cast<std::uint16_t>(0x70 + index - key_number(Key::kF1));
        } else {
          const auto offset =
              static_cast<std::size_t>(index - key_number(Key::kLeftShift));
          ASSERT_LT(offset, other_keys.size());
          expected = other_keys[offset];
        }
        ASSERT_THAT(press_key(key),
                    VariantWith<std::monostate>(std::monostate{}));
        ASSERT_EQ(system_.batches.size(), 1U);
        ASSERT_EQ(system_.batches.front().size(), 1U);
        const auto packet = system_.batches.front().front();
        EXPECT_EQ(packet.kind, InputPacketKind::kKeyboard);
        EXPECT_NE(packet.virtual_key, 0U);
        EXPECT_EQ(packet.virtual_key, expected);
        EXPECT_TRUE(mapped.insert(packet.virtual_key).second);
        InputEvent up{.kind = InputKind::kKeyUp, .key = key, .text = {}};
        EXPECT_THAT(injector_.inject(up),
                    VariantWith<std::monostate>(std::monostate{}));
        EXPECT_GT(up.inject_timestamp_ns, 0U);
        EXPECT_EQ(injector_.pressed_count(), 0U);
        system_.batches.clear();
      }
      EXPECT_THAT(press_key(Key::kNone),
                  VariantWith<PlatformError>(PlatformError::kNotSupported));
      EXPECT_THAT(press_key(Key::kCount),
                  VariantWith<PlatformError>(PlatformError::kNotSupported));
      EXPECT_TRUE(system_.batches.empty());
    }

#ifndef NDEBUG
    TEST_F(InputPacketsTest, Pw17DestructionWithPressedKeyAsserts) {
      EXPECT_DEATH(destroy_with_pressed_key(), "pressed_count_ == 0");
    }
#endif

    TEST_F(InputPacketsTest,
           Pw19CtrlCReleasesCBeforeCtrlEvenWhenCtrlWasPressedLast) {
      EXPECT_THAT(press_key(Key::kC),
                  VariantWith<std::monostate>(std::monostate{}));
      EXPECT_THAT(press_key(Key::kLeftCtrl),
                  VariantWith<std::monostate>(std::monostate{}));
      EXPECT_THAT(injector_.release_all_pressed(),
                  VariantWith<std::monostate>(std::monostate{}));
      EXPECT_EQ(injector_.pressed_count(), 0U);
      ASSERT_EQ(system_.batches.size(), 4U);
      EXPECT_THAT(system_.batches[2],
                  ElementsAre(InputPacket{.kind = InputPacketKind::kKeyboard,
                                          .flags = 2,
                                          .virtual_key = 0x43}));
      EXPECT_THAT(system_.batches[3],
                  ElementsAre(InputPacket{.kind = InputPacketKind::kKeyboard,
                                          .flags = 2,
                                          .virtual_key = 0xa2}));
    }

    TEST_F(InputPacketsTest, PartialNativeBatchDoesNotClaimAKnownPrefix) {
      system_.accepted = 2;
      InputEvent event{.kind = InputKind::kText, .text = "AB"};
      EXPECT_THAT(injector_.inject(event),
                  VariantWith<PlatformError>(PlatformError::kInternal));
      EXPECT_EQ(injector_.pressed_count(), 2U);
      system_.accepted.reset();
      EXPECT_THAT(injector_.release_all_pressed(),
                  VariantWith<std::monostate>(std::monostate{}));
      ASSERT_EQ(system_.batches.size(), 3U);
      EXPECT_THAT(system_.batches[1],
                  ElementsAre(InputPacket{.kind = InputPacketKind::kKeyboard,
                                          .flags = 6,
                                          .scan_code = u'B'}));
      EXPECT_THAT(system_.batches[2],
                  ElementsAre(InputPacket{.kind = InputPacketKind::kKeyboard,
                                          .flags = 6,
                                          .scan_code = u'A'}));
    }

    TEST_F(InputPacketsTest, OrdinaryInputRequiresInteractiveDesktopEvidence) {
      InputEvent event{.kind = InputKind::kKeyDown, .key = Key::kA, .text = {}};
      for (const auto state :
           {DesktopState::kLocked, DesktopState::kSecureDesktop}) {
        system_.state_value = state;
        EXPECT_THAT(injector_.inject(event),
                    VariantWith<PlatformError>(PlatformError::kSecureDesktop));
      }
      for (const auto state :
           {DesktopState::kLoggedOut, DesktopState::kUnknown}) {
        system_.state_value = state;
        EXPECT_THAT(
            injector_.inject(event),
            VariantWith<PlatformError>(PlatformError::kSessionNotInteractive));
      }
      EXPECT_TRUE(system_.batches.empty());
    }

    TEST_F(InputPacketsTest, NonTextEventRejectsBorrowedText) {
      InputEvent event{
          .kind = InputKind::kKeyDown, .key = Key::kA, .text = "not a key"};
      EXPECT_THAT(injector_.inject(event),
                  VariantWith<PlatformError>(PlatformError::kNotSupported));
      EXPECT_TRUE(system_.batches.empty());
      EXPECT_EQ(injector_.pressed_count(), 0U);
    }
#ifdef _WIN32
    TEST(InputInjectorNativeTest, UnboundDesktopStatePreventsOrdinaryInput) {
      InputInjectorWin injector;
      InputEvent event{.kind = InputKind::kKeyDown, .key = Key::kA, .text = {}};
      EXPECT_THAT(
          injector.inject(event),
          VariantWith<PlatformError>(PlatformError::kSessionNotInteractive));
    }
#endif
  }  // namespace
}  // namespace rd::platform::win
