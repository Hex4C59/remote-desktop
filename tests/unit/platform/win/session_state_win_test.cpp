// DS-01 through DS-03 and the observer portion of DS-06.
// Thread: none (unit test with explicit event ordering).
#include <array>
#include <cstddef>
#include <span>

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include "remotedesktop/platform/win/session_state_win.h"

namespace rd::platform::win {
  namespace {
    using ::testing::_;
    using ::testing::ElementsAre;
    using ::testing::IsEmpty;
    using ::testing::Return;
    using ::testing::VariantWith;

    class MockDesktopEventSource final : public DesktopEventSource {
     public:
      MOCK_METHOD(PlatformResult<DesktopObservation>, arm,
                  (LocalSessionGeneration, DesktopObserver, void*), (noexcept, override));
      MOCK_METHOD(void, disarm, (LocalSessionGeneration), (noexcept, override));
    };

    struct ObservationLog {
      static void record(void* context, DesktopObservation observation) noexcept {
        auto& log = *static_cast<ObservationLog*>(context);
        if (log.size < log.entries.size()) {
          log.entries[log.size++] = observation;
        } else {
          log.overflow = true;
        }
      }

      std::span<const DesktopObservation> observations() const noexcept {
        return std::span{entries}.first(size);
      }

      std::array<DesktopObservation, 8> entries{};
      std::size_t size{};
      bool overflow{};
    };

    struct Dispatch {
      DesktopObserver observer{};
      void* context{};

      void publish(DesktopObservation observation) const noexcept {
        if (observer != nullptr) {
          observer(context, observation);
        }
      }
    };

    class DesktopObserverTest : public ::testing::Test {
     protected:
      static constexpr LocalSessionGeneration kGeneration = 11;

      PlatformResult<DesktopObservation> subscribe(LocalSessionGeneration generation) {
        return observer_.subscribe(generation, &ObservationLog::record, &log_);
      }

      void arm(DesktopObservation snapshot, Dispatch& dispatch) {
        EXPECT_CALL(source_, arm(snapshot.generation, _, _))
            .WillOnce([snapshot, &dispatch](LocalSessionGeneration, DesktopObserver observer,
                                           void* context) {
              dispatch = {observer, context};
              return snapshot;
            });
      }

      MockDesktopEventSource source_;
      ObservationLog log_;
      SessionStateWin observer_{source_};
    };

    TEST_F(DesktopObserverTest, Ds01SnapshotAndLockCarryGenerationAndOrder) {
      const DesktopObservation initial{kGeneration, 1, DesktopState::kInteractive};
      const DesktopObservation locked{kGeneration, 2, DesktopState::kLocked};
      Dispatch dispatch;
      arm(initial, dispatch);
      EXPECT_THAT(subscribe(kGeneration), VariantWith<DesktopObservation>(initial));
      dispatch.publish(locked);
      EXPECT_THAT(log_.observations(), ElementsAre(locked));
      EXPECT_FALSE(log_.overflow);

      EXPECT_CALL(source_, disarm(kGeneration));
      observer_.unsubscribe(kGeneration);
    }

    TEST_F(DesktopObserverTest, Ds02SourceFailureLeavesGenerationAvailableForRetry) {
      const DesktopObservation initial{kGeneration, 1, DesktopState::kInteractive};
      Dispatch dispatch;
      EXPECT_CALL(source_, arm(kGeneration, _, _))
          .WillOnce(Return(PlatformResult<DesktopObservation>{PlatformError::kUnavailable}));
      EXPECT_THAT(subscribe(kGeneration), VariantWith<PlatformError>(PlatformError::kUnavailable));
      EXPECT_THAT(log_.observations(), IsEmpty());
      EXPECT_CALL(source_, disarm(kGeneration)).Times(0);
      observer_.unsubscribe(kGeneration);

      arm(initial, dispatch);
      EXPECT_THAT(subscribe(kGeneration), VariantWith<DesktopObservation>(initial));
      EXPECT_CALL(source_, disarm(kGeneration));
      observer_.unsubscribe(kGeneration);
    }

    TEST_F(DesktopObserverTest, Ds02NonInteractiveSnapshotPreservesClassification) {
      const std::array states{DesktopState::kUnknown, DesktopState::kLocked,
                             DesktopState::kSecureDesktop, DesktopState::kLoggedOut};
      auto generation = kGeneration;
      for (const auto state : states) {
        const DesktopObservation initial{generation, 1, state};
        Dispatch dispatch;
        arm(initial, dispatch);
        EXPECT_THAT(subscribe(generation), VariantWith<DesktopObservation>(initial));
        EXPECT_THAT(log_.observations(), IsEmpty());
        EXPECT_CALL(source_, disarm(generation));
        observer_.unsubscribe(generation);
        ++generation;
      }
    }

    TEST_F(DesktopObserverTest, Ds03NewerNotificationCanArriveBeforeInitialSnapshot) {
      const std::array initial_states{DesktopState::kInteractive, DesktopState::kLocked};
      auto generation = kGeneration;
      for (const auto initial_state : initial_states) {
        const auto next_state = initial_state == DesktopState::kInteractive
                                    ? DesktopState::kLocked : DesktopState::kInteractive;
        const DesktopObservation initial{generation, 1, initial_state};
        const DesktopObservation newer{generation, 2, next_state};
        log_ = {};
        EXPECT_CALL(source_, arm(generation, _, _))
            .WillOnce([this, initial, newer](LocalSessionGeneration, DesktopObserver observer,
                                             void* context) {
              observer(context, newer);
              EXPECT_THAT(log_.observations(), ElementsAre(newer));
              return initial;
            });
        EXPECT_THAT(subscribe(generation), VariantWith<DesktopObservation>(initial));
        EXPECT_THAT(log_.observations(), ElementsAre(newer));
        EXPECT_CALL(source_, disarm(generation));
        observer_.unsubscribe(generation);
        ++generation;
      }
    }

    TEST_F(DesktopObserverTest, Ds06InFlightOldObservationCannotBecomeCurrent) {
      const DesktopObservation old_initial{kGeneration, 1, DesktopState::kInteractive};
      const DesktopObservation current_initial{kGeneration + 1, 1, DesktopState::kInteractive};
      const DesktopObservation current_locked{kGeneration + 1, 2, DesktopState::kLocked};
      Dispatch old_dispatch;
      arm(old_initial, old_dispatch);
      EXPECT_THAT(subscribe(kGeneration), VariantWith<DesktopObservation>(old_initial));
      EXPECT_CALL(source_, disarm(kGeneration));
      observer_.unsubscribe(kGeneration);

      Dispatch current_dispatch;
      arm(current_initial, current_dispatch);
      EXPECT_THAT(subscribe(kGeneration + 1), VariantWith<DesktopObservation>(current_initial));
      old_dispatch.publish({kGeneration, 2, DesktopState::kLocked});
      old_dispatch.publish({kGeneration, 3, DesktopState::kInteractive});
      current_dispatch.publish(current_locked);
      const auto observations = log_.observations();
      ASSERT_FALSE(observations.empty());
      EXPECT_EQ(observations.back(), current_locked);
      for (const auto& late : observations.first(observations.size() - 1)) {
        EXPECT_EQ(late.generation, kGeneration);
      }
      EXPECT_FALSE(log_.overflow);

      EXPECT_CALL(source_, disarm(kGeneration + 1));
      observer_.unsubscribe(kGeneration + 1);
    }
  }  // namespace
}  // namespace rd::platform::win
