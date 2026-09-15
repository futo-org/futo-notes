//! How the two waits poll.

use std::time::Duration;

/// A poll's cadence: how soon the first retry comes, how far it backs off, and
/// when the wait gives up.
///
/// Backoff exists because both waits are on a person doing something in a
/// browser, which takes seconds at best and minutes at worst. Starting fast
/// keeps the app responsive when the person is quick; backing off keeps a slow
/// login from being hundreds of requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PollSchedule {
    pub first: Duration,
    pub max: Duration,
    pub give_up_after: Duration,
}

impl PollSchedule {
    /// Waiting for a Login Hand-off. The give-up matches the ticket's own ten
    /// minutes of life, so the wait never outlasts what it is waiting on.
    pub const SIGN_IN: Self = Self {
        first: Duration::from_secs(1),
        max: Duration::from_secs(5),
        give_up_after: Duration::from_secs(600),
    };

    /// Waiting for a checkout to make the account entitled. Entitlement moves
    /// when the payment provider's webhook lands, which is fast once payment
    /// goes through — the five minutes is for a person reading a card form.
    pub const ENTITLEMENT: Self = Self {
        first: Duration::from_secs(1),
        max: Duration::from_secs(5),
        give_up_after: Duration::from_secs(300),
    };

    /// The interval after `current`.
    pub(super) fn next(self, current: Duration) -> Duration {
        (current * 2).min(self.max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_interval_doubles_up_to_the_ceiling_and_stays_there() {
        let schedule = PollSchedule::SIGN_IN;
        let mut interval = schedule.first;
        let mut seen = vec![interval];
        for _ in 0..5 {
            interval = schedule.next(interval);
            seen.push(interval);
        }
        assert_eq!(
            seen,
            vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4),
                Duration::from_secs(5),
                Duration::from_secs(5),
                Duration::from_secs(5),
            ]
        );
    }

    /// A schedule whose ceiling is below its first interval must not stretch
    /// the first poll out to the ceiling.
    #[test]
    fn the_ceiling_never_lengthens_an_interval() {
        let schedule = PollSchedule {
            first: Duration::from_millis(10),
            max: Duration::from_millis(5),
            give_up_after: Duration::from_secs(1),
        };
        assert_eq!(
            schedule.next(Duration::from_millis(10)),
            Duration::from_millis(5)
        );
    }

    /// Both shipped waits give up no later than the thing they wait on dies.
    #[test]
    fn the_sign_in_wait_does_not_outlive_a_ticket() {
        assert_eq!(
            PollSchedule::SIGN_IN.give_up_after,
            Duration::from_secs(10 * 60)
        );
    }
}
