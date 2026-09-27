//! Maps one parsed method call to where it is answered: by the engine at
//! once, by the session thread in submission order, or by the connection
//! (`$/cancel`).

use senpi_desktop_core::methods::Method;
use senpi_desktop_core::protocol::{MethodRejection, RequestId};
use senpi_desktop_core::protocol_params::{AdvanceClockParams, CancelParams, EmptyParams};
use senpi_desktop_session::Op;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::engine::{Engine, SessionCall};
use crate::rpc::{to_result, Failure};

#[derive(Debug)]
pub enum Route {
    Immediate(Result<Value, Failure>),
    Session(SessionCall),
    Cancel(RequestId),
}

impl Engine {
    pub fn route(&self, method: Method, params: Value) -> Route {
        self.route_method(method, params)
            .unwrap_or_else(|failure| Route::Immediate(Err(failure)))
    }

    fn route_method(&self, method: Method, params: Value) -> Result<Route, Failure> {
        let op = |op| Ok(Route::Session(SessionCall::Op(op)));
        match method {
            Method::EngineHello => {
                parse::<EmptyParams>(params)?;
                Ok(Route::Immediate(to_result(Self::hello())))
            }
            Method::SessionOpen => Ok(Route::Session(SessionCall::Open(parse(params)?))),
            Method::SessionClose => {
                parse::<EmptyParams>(params)?;
                Ok(Route::Session(SessionCall::Close))
            }
            Method::Capabilities => {
                parse::<EmptyParams>(params)?;
                Ok(Route::Immediate(to_result(self.capabilities())))
            }
            Method::Displays => parse::<EmptyParams>(params).and_then(|_| op(Op::Displays)),
            Method::Windows => parse::<EmptyParams>(params).and_then(|_| op(Op::Windows)),
            Method::Capture => op(Op::Capture(parse(params)?)),
            Method::Click => op(Op::Click(parse(params)?)),
            Method::MoveMouse => op(Op::MoveMouse(parse(params)?)),
            Method::Drag => op(Op::Drag(parse(params)?)),
            Method::Scroll => op(Op::Scroll(parse(params)?)),
            Method::TypeText => op(Op::TypeText(parse(params)?)),
            Method::KeyChord => op(Op::KeyChord(parse(params)?)),
            Method::RaiseWindow => op(Op::RaiseWindow(parse(params)?)),
            Method::AxSnapshot => op(Op::AxSnapshot(parse(params)?)),
            Method::AxQuery => op(Op::AxQuery(parse(params)?)),
            Method::AxElementAt => op(Op::AxElementAt(parse(params)?)),
            Method::AxFocused => parse::<EmptyParams>(params).and_then(|_| op(Op::AxFocused)),
            Method::AxNode => op(Op::AxNode(parse(params)?)),
            Method::AxAttributes => op(Op::AxAttributes(parse(params)?)),
            Method::AxChildren => op(Op::AxChildren(parse(params)?)),
            Method::AxParent => op(Op::AxParent(parse(params)?)),
            Method::AxPerform => op(Op::AxPerform(parse(params)?)),
            Method::AxSetValue => op(Op::AxSetValue(parse(params)?)),
            Method::AxFocus => op(Op::AxFocus(parse(params)?)),
            Method::AxClick => op(Op::AxClick(parse(params)?)),
            Method::StopPathStatus => {
                parse::<EmptyParams>(params)?;
                Ok(Route::Immediate(to_result(self.stop_path_status())))
            }
            // Clipboard lands with the backends; the stop-path ladder with todo 12.
            Method::ClipboardRead
            | Method::ClipboardWrite
            | Method::StopPathStart
            | Method::StopPathHeartbeat
            | Method::StopPathStop
            | Method::StopPathResume => Err(Failure::not_implemented(method)),
            Method::Cancel => Ok(Route::Cancel(parse::<CancelParams>(params)?.id)),
            Method::TestAdvanceClock => {
                let Some(clock) = self.fake_clock() else {
                    return Err(Failure::Rejected(MethodRejection::TestOnly));
                };
                clock.advance(parse::<AdvanceClockParams>(params)?.ms);
                Ok(Route::Immediate(Ok(Value::Null)))
            }
        }
    }
}

/// Absent params mean `{}`.
fn parse<T: DeserializeOwned>(params: Value) -> Result<T, Failure> {
    let params = match params {
        Value::Null => Value::Object(Map::new()),
        present => present,
    };
    serde_json::from_value(params).map_err(|error| Failure::InvalidParams(format!("invalid params: {error}")))
}
