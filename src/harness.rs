//! Harness process lifecycle: spawn the official DeepSeek Harness `web`
//! profile, stream stdout/stderr into shared state, detect its `dsh web:`
//! authenticated URL, surface startup failures, and kill the process tree.

use crate::runtime::HarnessRuntime;
use crate::state::{AppState, Phase};
use log::{debug, error, info, warn};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct HarnessConfig {
    pub runtime: HarnessRuntime,
    pub dsh_home: PathBuf,
    /// The official CLI treats its invoking directory as the initial workspace.
    pub workspace: PathBuf,
    /// Explicit port; `None` lets the OS pick (`--port 0`).
    pub port: Option<u16>,
}

#[derive(Debug)]
pub enum HarnessCmd {
    Start,
    Stop,
}

#[derive(Debug)]
pub enum HarnessOutcome {
    Ready { url: String },
    Failed { reason: String },
    Exited { code: Option<i32> },
}

/// Extract the `dsh web: <url>` launch line from a harness output line.
fn extract_launch_url(line: &str) -> Option<String> {
    let marker = "dsh web:";
    let idx = line.find(marker)?;
    let rest = line[idx + marker.len()..].trim();
    // The line may carry ` (LAN: http://...)` after the loopback URL.
    let url = rest
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_end_matches([')', '(']);
    if url.is_empty() || !url.starts_with("http") {
        return None;
    }
    // Only accept the loopback URL we asked for.
    if !url.starts_with("http://127.0.0.1:") {
        return None;
    }
    Some(url.to_string())
}

fn port_from_url(url: &str) -> Option<u16> {
    let rest = url.strip_prefix("http://127.0.0.1:")?;
    let port_str = rest.split(['/', '?']).next()?;
    port_str.parse().ok()
}

fn startup_failure_reason(line: &str) -> Option<String> {
    for marker in [
        "DSH entry failed:",
        "uncaught exception:",
        "unhandled rejection:",
    ] {
        if let Some(idx) = line.find(marker) {
            let rest = line[idx + marker.len()..].trim();
            let reason = if rest.is_empty() {
                marker.trim_end_matches(':').to_string()
            } else {
                rest.chars().take(400).collect()
            };
            return Some(reason);
        }
    }
    None
}

#[cfg(windows)]
fn kill_tree(child: &mut Child) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/pid", &child.id().to_string(), "/t", "/f"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(windows))]
fn kill_tree(child: &mut Child) {
    use std::os::unix::process::CommandExt;
    let _ = Command::new("kill")
        .arg(format!("-{}", child.id()))
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

fn harness_command(config: &HarnessConfig) -> Command {
    let port = config.port.unwrap_or(0).to_string();
    let mut cmd = Command::new(&config.runtime.program);
    cmd.args(&config.runtime.prefix_args).arg("web");
    if config.runtime.supports_no_open {
        cmd.arg("--no-open");
    }
    cmd.arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(&port)
        .current_dir(&config.workspace)
        .env("DSH_HOME", &config.dsh_home)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    debug!(
        "spawning harness via {} web --port {}",
        config.runtime.program.display(),
        port
    );
    cmd
}

fn spawn_harness(config: &HarnessConfig) -> std::io::Result<Child> {
    harness_command(config).spawn()
}

fn spawn_reader<R: std::io::Read + Send + 'static>(
    reader: R,
    source: &'static str,
    state: AppState,
    on_line: impl Fn(&str) + Send + 'static,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let buffered = BufReader::new(reader);
        for line in buffered.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            state.push_log(format!("[{source}] {line}"));
            on_line(&line);
        }
    })
}

/// Run one harness lifecycle: spawn, wait for readiness, keep watching until
/// the process exits or a Stop is requested. Emits `HarnessOutcome` via the
/// caller-supplied callback.
pub fn run_once(
    config: &HarnessConfig,
    state: &AppState,
    cmd_rx: &Receiver<HarnessCmd>,
    mut on_outcome: impl FnMut(HarnessOutcome),
) {
    let mut child = match spawn_harness(config) {
        Ok(child) => child,
        Err(err) => {
            let reason = format!("could not spawn the Harness process: {err}");
            error!("{reason}");
            state.set_phase(Phase::Failed, &reason);
            on_outcome(HarnessOutcome::Failed { reason });
            return;
        }
    };
    let pid = child.id();
    state.set_pid(Some(pid));
    info!("harness started (pid {pid})");
    state.set_phase(
        Phase::Starting,
        format!("Starting {}…", config.runtime.description),
    );

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let state_stdout = state.clone();
    let state_stderr = state.clone();
    let launch_seen = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let launch_seen_stdout = launch_seen.clone();
    let launch_url = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let launch_url_stdout = launch_url.clone();

    if let Some(stdout) = stdout {
        spawn_reader(stdout, "stdout", state_stdout, move |line| {
            if let Some(url) = extract_launch_url(line) {
                launch_seen_stdout.store(true, std::sync::atomic::Ordering::SeqCst);
                *launch_url_stdout.lock().unwrap() = Some(url.clone());
                info!("harness ready: {url}");
            }
        });
    }
    let failed_reason = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let failed_reason_stderr = failed_reason.clone();
    if let Some(stderr) = stderr {
        spawn_reader(stderr, "stderr", state_stderr, move |line| {
            if let Some(reason) = startup_failure_reason(line) {
                let mut guard = failed_reason_stderr.lock().unwrap();
                if guard.is_none() {
                    *guard = Some(reason);
                }
            }
        });
    }

    // Watch until the process exits, a Stop arrives, or readiness is detected.
    let mut announced = false;
    let deadline = Instant::now() + Duration::from_secs(config.runtime.startup_timeout_secs);
    loop {
        // Handle commands without blocking the watcher.
        match cmd_rx.try_recv() {
            Ok(HarnessCmd::Stop) | Err(TryRecvError::Disconnected) => {
                info!("stop requested; killing harness");
                kill_tree(&mut child);
                state.set_phase(Phase::Stopping, "Stopping Harness…");
                return;
            }
            Ok(HarnessCmd::Start) | Err(TryRecvError::Empty) => {}
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code();
                let failed = {
                    let guard = failed_reason.lock().unwrap();
                    guard.clone()
                };
                if let Some(reason) = failed {
                    warn!("harness failed during startup: {reason}");
                    state.set_phase(Phase::Failed, &reason);
                    on_outcome(HarnessOutcome::Failed { reason });
                } else if announced {
                    let reason = format!(
                        "Harness stopped unexpectedly (exit code {}).",
                        code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())
                    );
                    error!("{reason}");
                    state.set_phase(Phase::Failed, &reason);
                    on_outcome(HarnessOutcome::Exited { code });
                } else {
                    let reason = format!(
                        "Harness exited before becoming ready (exit code {}).",
                        code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())
                    );
                    error!("{reason}");
                    state.set_phase(Phase::Failed, &reason);
                    on_outcome(HarnessOutcome::Exited { code });
                }
                return;
            }
            Ok(None) => {}
            Err(err) => {
                error!("failed to wait on harness: {err}");
                return;
            }
        }

        // Readiness: the `dsh web:` line carries the URL; verify the port
        // actually accepts connections before announcing.
        if !announced
            && let Some(url) = launch_url.lock().unwrap().clone()
            && let Some(port) = port_from_url(&url)
            && tcp_ready("127.0.0.1", port, Duration::from_millis(250))
        {
            announced = true;
            state.set_launch(url.clone(), port);
            state.set_phase(Phase::Ready, "Harness is ready.");
            on_outcome(HarnessOutcome::Ready { url });
        }

        if Instant::now() > deadline && !announced {
            let reason = format!(
                "Harness did not become ready within {} seconds.",
                config.runtime.startup_timeout_secs
            );
            error!("{reason}");
            kill_tree(&mut child);
            state.set_phase(Phase::Failed, &reason);
            on_outcome(HarnessOutcome::Failed { reason });
            return;
        }

        thread::sleep(Duration::from_millis(100));
    }
}

fn tcp_ready(host: &str, port: u16, timeout: Duration) -> bool {
    use std::net::TcpStream;
    TcpStream::connect_timeout(&format!("{host}:{port}").parse().unwrap(), timeout).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn test_config(port: Option<u16>) -> HarnessConfig {
        HarnessConfig {
            runtime: HarnessRuntime {
                program: PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }),
                prefix_args: vec![OsString::from(
                    "runtime/node_modules/@deepseek-ai/dsh/lib/bin.js",
                )],
                supports_no_open: true,
                startup_timeout_secs: 180,
                description: "test installed official package".to_string(),
            },
            dsh_home: PathBuf::from("test-home"),
            workspace: PathBuf::from("test-workspace"),
            port,
        }
    }

    #[test]
    fn command_uses_the_installed_official_web_cli() {
        let command = harness_command(&test_config(None));
        let args: Vec<_> = command.get_args().map(OsString::from).collect();
        assert_eq!(
            args,
            [
                "runtime/node_modules/@deepseek-ai/dsh/lib/bin.js",
                "web",
                "--no-open",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
            ]
            .map(OsString::from)
        );
        assert_eq!(
            command.get_current_dir(),
            Some(std::path::Path::new("test-workspace"))
        );
    }

    #[test]
    fn command_forwards_an_explicit_port() {
        let command = harness_command(&test_config(Some(61509)));
        let args: Vec<_> = command.get_args().map(OsString::from).collect();
        assert_eq!(args.last(), Some(&OsString::from("61509")));
    }

    #[test]
    fn runtime_without_no_open_support_omits_the_flag() {
        let mut config = test_config(None);
        config.runtime.supports_no_open = false;
        let command = harness_command(&config);
        assert!(!command.get_args().any(|argument| argument == "--no-open"));
    }

    #[test]
    fn extract_launch_url_parses_loopback_with_token() {
        let line = "dsh web: http://127.0.0.1:51234/?token=abc123";
        assert_eq!(
            extract_launch_url(line).as_deref(),
            Some("http://127.0.0.1:51234/?token=abc123")
        );
    }

    #[test]
    fn extract_launch_url_ignores_lan_suffix() {
        let line =
            "dsh web: http://127.0.0.1:51234/?token=abc (LAN: http://192.168.1.2:51234/?token=xyz)";
        assert_eq!(
            extract_launch_url(line).as_deref(),
            Some("http://127.0.0.1:51234/?token=abc")
        );
    }

    #[test]
    fn extract_launch_url_rejects_non_loopback() {
        assert!(extract_launch_url("dsh web: http://192.168.1.2:51234/?token=abc").is_none());
        assert!(extract_launch_url("dsh web: https://example.com/?token=abc").is_none());
    }

    #[test]
    fn extract_launch_url_ignores_other_lines() {
        assert!(extract_launch_url("[harness-node] runtime node=v24.9.0").is_none());
        assert!(extract_launch_url("").is_none());
    }

    #[test]
    fn port_from_url_extracts_port() {
        assert_eq!(
            port_from_url("http://127.0.0.1:51234/?token=abc"),
            Some(51234)
        );
        assert_eq!(port_from_url("http://127.0.0.1:0/"), Some(0));
        assert!(port_from_url("http://127.0.0.2:51234/").is_none());
        assert!(port_from_url("http://127.0.0.1:notaport/").is_none());
    }

    #[test]
    fn startup_failure_reason_detects_entry_failure() {
        let line = "DSH entry failed: Error: missing profile";
        assert_eq!(
            startup_failure_reason(line).as_deref(),
            Some("Error: missing profile")
        );
        let line = "uncaught exception: TypeError: x is not a function";
        assert_eq!(
            startup_failure_reason(line).as_deref(),
            Some("TypeError: x is not a function")
        );
        let line = "unhandled rejection: boom";
        assert_eq!(startup_failure_reason(line).as_deref(), Some("boom"));
    }

    #[test]
    fn startup_failure_reason_ignores_benign_lines() {
        assert!(startup_failure_reason("[harness-node] DSH entry loaded").is_none());
        assert!(startup_failure_reason("dsh web: http://127.0.0.1:51234/?token=abc").is_none());
        assert!(startup_failure_reason("").is_none());
    }
}
