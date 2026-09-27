#![cfg(target_os = "windows")]

//! Windows desktop backend.
//! Skeleton: later lanes own the implementation.

pub const BACKEND_NAME: &str = env!("CARGO_PKG_NAME");

/// Windows-only std path so the crate-root `cfg(target_os)` is load-bearing:
/// `cargo check` on non-Windows fails if this file is compiled without the cfg.
pub type NativeHandle = std::os::windows::io::RawHandle;
