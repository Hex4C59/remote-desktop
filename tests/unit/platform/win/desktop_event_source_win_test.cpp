// DS-01–03 and DS-06 at the native desktop signal boundary.
// Thread: none (scripted Session-thread dispatch).
#include <array>
#include <cstddef>
#include <span>

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include "remotedesktop/platform/win/desktop_event_source_win.h"

namespace rd::platform::win {
  namespace {
    using ::testing::_;
    using ::testing::ElementsAre;
    using ::testing::InSequence;
    using ::testing::IsEmpty;
    using ::testing::Return;
    using ::testing::VariantWith;

    constexpr DesktopEvidence kInteractive{SessionEvidence::kUnlocked, InputDesktopEvidence::kDefault};

    class MockDesktopSignals : public DesktopSignals {
     public:
      MOCK_METHOD(PlatformResult<void>, start, (DesktopSignalSink, void*), (noexcept, override));
      MOCK_METHOD(void, stop, (), (noexcept, override));
      MOCK_METHOD(void, pump, (), (noexcept, override));
      MOCK_METHOD(DesktopEvidence, probe, (), (noexcept, override));
    };

    class DesktopSourceTest : public ::testing::Test {
     protected:
      static constexpr LocalSessionGeneration kGeneration = 7;

      PlatformResult<DesktopObservation> arm(LocalSessionGeneration generation = kGeneration) {
        return source_.arm(generation, &record, this);
      }

      void allow_start() {
        EXPECT_CALL(signals_, start(_, _)).WillOnce([this](DesktopSignalSink sink, void* context) {
          sink_ = sink;
          context_ = context;
          return std::monostate{};
        });
      }

      void signal(DesktopSignal value) const noexcept {
        if (sink_) {
          sink_(context_, value);
        }
      }

      void disarm(LocalSessionGeneration generation = kGeneration) {
        EXPECT_CALL(signals_, stop());
        source_.disarm(generation);
      }

      std::span<const DesktopObservation> observations() const noexcept {
        return std::span{observations_}.first(count_);
      }

      ::testing::StrictMock<MockDesktopSignals> signals_;
      DesktopEventSourceWin source_{signals_};

     private:
      static void record(void* context, DesktopObservation observation) noexcept {
        auto& self = *static_cast<DesktopSourceTest*>(context);
        if (self.count_ < self.observations_.size()) {
          self.observations_[self.count_++] = observation;
        } else {
          ADD_FAILURE() << "unexpected extra observation";
        }
      }

      DesktopSignalSink sink_{};
      void* context_{};
      std::array<DesktopObservation, 12> observations_{};
      std::size_t count_{};
    };

    TEST_F(DesktopSourceTest, RegistersBeforeProbeAndPublishesLockAndLogoffInOrder) {
      const InSequence order;
      allow_start();
      EXPECT_CALL(signals_, probe()).WillOnce(Return(kInteractive));
      const auto snapshot = DesktopObservation{kGeneration, 1, DesktopState::kInteractive};
      EXPECT_THAT(arm(), VariantWith<DesktopObservation>(snapshot));
      EXPECT_CALL(signals_, pump()).WillOnce([this] {
        signal(DesktopSignal::kLock);
        signal(DesktopSignal::kLock);
        signal(DesktopSignal::kLogoff);
      });
      source_.pump_notifications();
      EXPECT_THAT(observations(), ElementsAre(DesktopObservation{kGeneration, 2, DesktopState::kLocked},
                                              DesktopObservation{kGeneration, 3, DesktopState::kLoggedOut}));
      disarm();
    }

    TEST_F(DesktopSourceTest, StartFailureDeliversNothingAndAllowsRetry) {
      EXPECT_CALL(signals_, start(_, _)).WillOnce([](DesktopSignalSink sink, void* context) {
        sink(context, DesktopSignal::kLock);
        return PlatformError::kPermissionDenied;
      });
      EXPECT_THAT(arm(), VariantWith<PlatformError>(PlatformError::kPermissionDenied));
      EXPECT_THAT(observations(), IsEmpty());
      source_.disarm(kGeneration);
      source_.pump_notifications();

      allow_start();
      EXPECT_CALL(signals_, probe()).WillOnce(Return(DesktopEvidence{}));
      EXPECT_THAT(arm(), VariantWith<DesktopObservation>(DesktopObservation{kGeneration, 1, DesktopState::kUnknown}));
      disarm();
    }

    TEST_F(DesktopSourceTest, InitialStateRequiresPositiveEvidence) {
      struct Case { DesktopEvidence evidence; DesktopState state; };
      const std::array cases{
        Case{{SessionEvidence::kUnknown, InputDesktopEvidence::kDefault}, DesktopState::kUnknown},
        Case{{SessionEvidence::kUnlocked, InputDesktopEvidence::kUnknown}, DesktopState::kUnknown},
        Case{{SessionEvidence::kUnlocked, InputDesktopEvidence::kSecure}, DesktopState::kSecureDesktop},
        Case{{SessionEvidence::kLocked, InputDesktopEvidence::kDefault}, DesktopState::kLocked},
      };
      auto generation = kGeneration;
      for (const auto& entry : cases) {
        allow_start();
        EXPECT_CALL(signals_, probe()).WillOnce(Return(entry.evidence));
        EXPECT_THAT(arm(generation), VariantWith<DesktopObservation>(DesktopObservation{generation, 1, entry.state}));
        disarm(generation);
        ++generation;
      }
      EXPECT_THAT(observations(), IsEmpty());
    }

    TEST_F(DesktopSourceTest, LockDuringInitialProbePrecedesReturnAndIsNotOverwritten) {
      const auto locked = DesktopObservation{kGeneration, 2, DesktopState::kLocked};
      allow_start();
      EXPECT_CALL(signals_, probe()).WillOnce([this, locked] {
        signal(DesktopSignal::kLock);
        EXPECT_THAT(observations(), ElementsAre(locked));
        return kInteractive;
      });
      EXPECT_THAT(arm(), VariantWith<DesktopObservation>(DesktopObservation{kGeneration, 1, DesktopState::kInteractive}));
      EXPECT_CALL(signals_, pump()).WillOnce([this] { signal(DesktopSignal::kDesktopSwitch); });
      source_.pump_notifications();
      EXPECT_THAT(observations(), ElementsAre(locked));

      EXPECT_CALL(signals_, pump()).WillOnce([this] { signal(DesktopSignal::kRecheck); });
      EXPECT_CALL(signals_, probe()).WillOnce(Return(kInteractive));
      source_.pump_notifications();
      EXPECT_THAT(observations(), ElementsAre(locked, DesktopObservation{kGeneration, 3, DesktopState::kInteractive}));
      disarm();
    }

    TEST_F(DesktopSourceTest, DesktopSwitchPublishesUnknownAndUnlockNeedsConfirmedProbe) {
      allow_start();
      EXPECT_CALL(signals_, probe()).WillOnce(Return(kInteractive));
      EXPECT_THAT(arm(), VariantWith<DesktopObservation>(DesktopObservation{kGeneration, 1, DesktopState::kInteractive}));
      EXPECT_CALL(signals_, pump()).WillOnce([this] { signal(DesktopSignal::kDesktopSwitch); });
      EXPECT_CALL(signals_, probe()).WillOnce(Return(DesktopEvidence{SessionEvidence::kUnlocked, InputDesktopEvidence::kUnknown}));
      source_.pump_notifications();
      const auto unknown = DesktopObservation{kGeneration, 2, DesktopState::kUnknown};
      EXPECT_THAT(observations(), ElementsAre(unknown));
      EXPECT_CALL(signals_, pump()).WillOnce([this] { signal(DesktopSignal::kRecheck); });
      EXPECT_CALL(signals_, probe()).WillOnce(Return(kInteractive));
      source_.pump_notifications();
      EXPECT_THAT(observations(), ElementsAre(unknown, DesktopObservation{kGeneration, 3, DesktopState::kInteractive}));
      disarm();
    }

    TEST_F(DesktopSourceTest, LockInvalidatesRecoveryProbeInProgress) {
      allow_start();
      EXPECT_CALL(signals_, probe()).WillOnce(Return(kInteractive));
      EXPECT_THAT(arm(), VariantWith<DesktopObservation>(DesktopObservation{kGeneration, 1, DesktopState::kInteractive}));
      EXPECT_CALL(signals_, pump()).WillOnce([this] { signal(DesktopSignal::kDesktopSwitch); });
      EXPECT_CALL(signals_, probe()).WillOnce([this] {
        signal(DesktopSignal::kLock);
        return kInteractive;
      });
      source_.pump_notifications();
      EXPECT_THAT(observations(), ElementsAre(DesktopObservation{kGeneration, 2, DesktopState::kUnknown},
                                              DesktopObservation{kGeneration, 3, DesktopState::kLocked}));
      disarm();
    }

    TEST_F(DesktopSourceTest, RevokesBeforeStopAndResetsSequenceForNewGeneration) {
      allow_start();
      EXPECT_CALL(signals_, probe()).WillOnce(Return(kInteractive));
      EXPECT_THAT(arm(), VariantWith<DesktopObservation>(DesktopObservation{kGeneration, 1, DesktopState::kInteractive}));
      EXPECT_THAT(arm(kGeneration + 1), VariantWith<PlatformError>(PlatformError::kAlreadyInitialized));
      source_.disarm(kGeneration + 1);
      EXPECT_CALL(signals_, stop()).WillOnce([this] { signal(DesktopSignal::kLock); });
      source_.disarm(kGeneration);
      EXPECT_THAT(observations(), IsEmpty());

      allow_start();
      EXPECT_CALL(signals_, probe()).WillOnce(Return(kInteractive));
      EXPECT_THAT(arm(kGeneration + 1), VariantWith<DesktopObservation>(DesktopObservation{kGeneration + 1, 1, DesktopState::kInteractive}));
      EXPECT_CALL(signals_, pump()).WillOnce([this] { signal(DesktopSignal::kDisconnect); });
      source_.pump_notifications();
      EXPECT_THAT(observations(), ElementsAre(DesktopObservation{kGeneration + 1, 2, DesktopState::kUnknown}));
      disarm(kGeneration + 1);
    }
  }  // namespace
}  // namespace rd::platform::win
