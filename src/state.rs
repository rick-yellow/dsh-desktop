//! Shared application state: harness phase, message, launch URL, and a
//! bounded ring buffer of harness output lines.
//!
//! This mirrors the phase model of the Electron shell
//! (idle -> starting -> ready / failed -> stopping) so the UI and the IPC
//! protocol can render the same lifecycle.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, RwLock};
use std::time::Instant;

pub const MAX_LOG_LINES: usize = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    #[default]
    Idle,
    Starting,
    Ready,
    Failed,
    Stopping,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusSnapshot {
    pub phase: Phase,
    pub message: String,
    pub url: Option<String>,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub elapsed_secs: u64,
}

#[derive(Default)]
struct Inner {
    phase: Phase,
    message: String,
    started_at: Option<Instant>,
    url: Option<String>,
    port: Option<u16>,
    pid: Option<u32>,
    logs: VecDeque<String>,
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<RwLock<Inner>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(Inner::default())),
        }
    }

    pub fn set_phase(&self, phase: Phase, message: impl Into<String>) {
        let mut inner = self.inner.write().unwrap();
        inner.phase = phase;
        inner.message = message.into();
        match phase {
            Phase::Starting => {
                inner.started_at = Some(Instant::now());
            }
            Phase::Idle => {
                inner.started_at = None;
                inner.url = None;
                inner.port = None;
                inner.pid = None;
            }
            _ => {}
        }
    }

    pub fn set_pid(&self, pid: Option<u32>) {
        self.inner.write().unwrap().pid = pid;
    }

    pub fn set_launch(&self, url: String, port: u16) {
        let mut inner = self.inner.write().unwrap();
        inner.url = Some(url);
        inner.port = Some(port);
    }

    pub fn push_log(&self, line: String) {
        let mut inner = self.inner.write().unwrap();
        if inner.logs.len() >= MAX_LOG_LINES {
            inner.logs.pop_front();
        }
        inner.logs.push_back(line);
    }

    pub fn logs(&self, last_n: usize) -> Vec<String> {
        let inner = self.inner.read().unwrap();
        let skip = inner.logs.len().saturating_sub(last_n);
        inner.logs.iter().skip(skip).cloned().collect()
    }

    pub fn snapshot(&self) -> StatusSnapshot {
        let inner = self.inner.read().unwrap();
        let elapsed = inner.started_at.map(|t| t.elapsed().as_secs()).unwrap_or(0);
        StatusSnapshot {
            phase: inner.phase,
            message: inner.message.clone(),
            url: inner.url.clone(),
            port: inner.port,
            pid: inner.pid,
            elapsed_secs: elapsed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_state_is_idle() {
        let state = AppState::new();
        let snapshot = state.snapshot();
        assert_eq!(snapshot.phase, Phase::Idle);
        assert_eq!(snapshot.elapsed_secs, 0);
        assert!(snapshot.url.is_none());
        assert!(snapshot.port.is_none());
        assert!(snapshot.pid.is_none());
    }

    #[test]
    fn set_phase_records_message() {
        let state = AppState::new();
        state.set_phase(Phase::Starting, "Starting DeepSeek Harness…");
        let snapshot = state.snapshot();
        assert_eq!(snapshot.phase, Phase::Starting);
        assert_eq!(snapshot.message, "Starting DeepSeek Harness…");
    }

    #[test]
    fn idle_resets_launch_state() {
        let state = AppState::new();
        state.set_pid(Some(42));
        state.set_launch("http://127.0.0.1:1234/?token=x".to_string(), 1234);
        state.set_phase(Phase::Ready, "ready");
        state.set_phase(Phase::Idle, "not running");
        let snapshot = state.snapshot();
        assert_eq!(snapshot.phase, Phase::Idle);
        assert!(snapshot.url.is_none());
        assert!(snapshot.port.is_none());
        assert!(snapshot.pid.is_none());
    }

    #[test]
    fn set_launch_tracks_url_and_port() {
        let state = AppState::new();
        state.set_launch("http://127.0.0.1:5555/?token=abc".to_string(), 5555);
        let snapshot = state.snapshot();
        assert_eq!(
            snapshot.url.as_deref(),
            Some("http://127.0.0.1:5555/?token=abc")
        );
        assert_eq!(snapshot.port, Some(5555));
    }

    #[test]
    fn logs_ring_buffer_caps_at_max() {
        let state = AppState::new();
        for i in 0..(MAX_LOG_LINES + 25) {
            state.push_log(format!("line {i}"));
        }
        let logs = state.logs(usize::MAX);
        assert_eq!(logs.len(), MAX_LOG_LINES);
        assert_eq!(logs.first().map(String::as_str), Some("line 25"));
        assert_eq!(
            logs.last().map(String::as_str),
            Some(format!("line {}", MAX_LOG_LINES + 24).as_str())
        );
    }

    #[test]
    fn logs_respects_last_n() {
        let state = AppState::new();
        for i in 0..10 {
            state.push_log(format!("line {i}"));
        }
        let logs = state.logs(3);
        assert_eq!(
            logs,
            vec![
                "line 7".to_string(),
                "line 8".to_string(),
                "line 9".to_string()
            ]
        );
    }
}
