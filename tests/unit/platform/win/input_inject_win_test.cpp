// PW-18 and PW-21 platform bookkeeping through a scripted press backend.
// Thread: none (unit test).
#include <span>

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
  }  // namespace
}  // namespace rd::platform::win
