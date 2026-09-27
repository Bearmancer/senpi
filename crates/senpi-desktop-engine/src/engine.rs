//! Engine-wide state shared by every connection: the one desktop session,
//! the supervisor and its (possibly fake) clock, the resume token, and the
//! request permits.

use std::sync::Arc;

use senpi_desktop_core::error::{CoreResult, DesktopError};
use senpi_desktop_core::methods::Effect;
use senpi_desktop_core::protocol::{ABI, PROTOCOL_VERSION};
use senpi_desktop_core::protocol_results::{HelloResult, SessionOpenResult, StopPathKind, StopPathStatus};
use senpi_desktop_core::types::{DesktopCapabilities, DesktopSessionOptions};
use senpi_desktop_safety::{ActiveStopPath, Clock, FakeClock, MonotonicClock, Supervisor};
use senpi_desktop_session::{Op, Pending, Response, Session};
use serde_json::Value;
use tokio::sync::Semaphore;
use ulid::Ulid;

use crate::config::EngineConfig;
use crate::rpc::{to_result, Failure};

/// Read-only session requests that may be in flight at once.
pub const READ_CONCURRENCY: usize = 4;

/// A request the session thread serves, in submission order.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionCall {
    Open(DesktopSessionOptions),
    Close,
    Op(Op),
}

pub struct Engine {
    session: Session,
    supervisor: Supervisor,
    fake_clock: Option<Arc<FakeClock>>,
    /// Returned only in the `session.open` reply; lifts a stop latch.
    resume_token: String,
    read_permits: Arc<Semaphore>,
    /// One mutating request in flight at a time.
    exec_permits: Arc<Semaphore>,
}

impl Engine {
    /// Selects the backend and starts the session thread.
    ///
    /// # Errors
    /// `Internal` when the session thread cannot start.
    pub fn start(config: EngineConfig) -> CoreResult<Self> {
        let fake_clock = config.fake_clock.then(|| Arc::new(FakeClock::new(0)));
        let clock: Arc<dyn Clock> = match &fake_clock {
            Some(fake) => Arc::clone(fake) as Arc<dyn Clock>,
            None => Arc::new(MonotonicClock::new()),
        };
        Ok(Self {
            session: Session::start(config.selection, config.timeouts)?,
            supervisor: Supervisor::new(clock),
            fake_clock,
            resume_token: Ulid::generate().to_string(),
            read_permits: Arc::new(Semaphore::new(READ_CONCURRENCY)),
            exec_permits: Arc::new(Semaphore::new(1)),
        })
    }

    pub fn hello() -> HelloResult {
        HelloResult {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            engine_version: env!("CARGO_PKG_VERSION").to_owned(),
            build_sha: option_env!("SENPI_DESKTOP_BUILD_SHA")
                .unwrap_or("unknown")
                .to_owned(),
            abi: ABI.to_owned(),
        }
    }

    /// Answered from the session's cache, so a busy backend never delays it.
    pub fn capabilities(&self) -> DesktopCapabilities {
        self.session.capabilities()
    }

    pub fn stop_path_status(&self) -> StopPathStatus {
        let status = self.supervisor.status();
        StopPathStatus {
            suspended: status.suspended,
            global_live: status.global_live,
            host_relay_live: status.host_relay_live,
            heartbeat_fresh: status.heartbeat_fresh,
            stop_path: match status.stop_path {
                ActiveStopPath::Global => StopPathKind::Global,
                ActiveStopPath::HostRelay => StopPathKind::HostRelay,
                ActiveStopPath::None => StopPathKind::None,
            },
            reason: None,
        }
    }

    /// The installed fake clock, when `SENPI_DESKTOP_FAKE_CLOCK=1` set one.
    pub fn fake_clock(&self) -> Option<&FakeClock> {
        self.fake_clock.as_deref()
    }

    pub fn permits(&self, effect: Effect) -> Arc<Semaphore> {
        match effect {
            Effect::Read => Arc::clone(&self.read_permits),
            Effect::Exec => Arc::clone(&self.exec_permits),
        }
    }

    /// Enqueues `call` on the session thread now; the reply comes from
    /// [`Started::wait`].
    pub fn begin(&self, call: SessionCall) -> Started {
        match call {
            SessionCall::Open(options) => Started {
                pending: self.session.open(options),
                resume_token: Some(self.resume_token.clone()),
            },
            SessionCall::Close => Started {
                pending: self.session.close(),
                resume_token: None,
            },
            SessionCall::Op(op) => Started {
                pending: self.session.submit(op),
                resume_token: None,
            },
        }
    }

    /// Closes the session at the end of the engine's life.
    pub async fn shutdown(&self) {
        if let Err(error) = self.session.close().wait().await {
            eprintln!("senpi-desktop-engine: closing the desktop session failed: {error}");
        }
    }
}

/// An enqueued session request.
pub struct Started {
    pending: Pending,
    /// `Some` for `session.open`, whose reply carries the token.
    resume_token: Option<String>,
}

impl Started {
    /// # Errors
    /// The session's error for this request.
    pub async fn wait(self) -> Result<Value, Failure> {
        let response = self.pending.wait().await.map_err(Failure::Engine)?;
        match (self.resume_token, response) {
            (Some(resume_token), Response::Capabilities(capabilities)) => to_result(SessionOpenResult {
                capabilities,
                resume_token,
            }),
            (Some(_), other) => Err(Failure::Engine(DesktopError::internal(format!(
                "session.open answered {other:?}"
            )))),
            (None, response) => to_result(response),
        }
    }
}
