//! Fail-closed supervisor and stop-path registry for desktop input.
//! `gate()` lands in a later lane.

mod clock;
mod reset;
mod supervisor;

pub use clock::{Clock, FakeClock, MonotonicClock};
pub use reset::{ResumeToken, UserReset};
pub use supervisor::{
    ActiveStopPath, StopPathId, StopPolicy, StopSource, Supervisor, SupervisorStatus, HEARTBEAT_FRESH_MS,
    HEARTBEAT_INTERVAL_MS,
};
