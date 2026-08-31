//! dsh-desktop-rust — a native Rust desktop wrapper around the open-source
//! DeepSeek Harness (DSH) web GUI.
//!
//! The binary boots the official published package or a built checkout of
//! https://github.com/deepseek-ai/deepseek-harness, hosts its web GUI in a
//! native WebView2 window, and manages the process lifecycle. See README.md.

mod harness;
mod logger;
mod pages;
mod protocol;
mod runtime;
mod state;

use crate::harness::{HarnessCmd, HarnessConfig, HarnessOutcome};
use crate::protocol::AppEvent;
use crate::state::AppState;
use log::{error, info, warn};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_HARNESS_PORT: u16 = 3080;
const WEBVIEW_INIT_SCRIPT: &str = include_str!("webview.js");

fn select_harness_port(requested: Option<u16>, default_port_available: bool) -> u16 {
    match requested {
        Some(port) => port,
        None if default_port_available => DEFAULT_HARNESS_PORT,
        None => 0,
    }
}

fn harness_port(requested: Option<u16>) -> u16 {
    match requested {
        Some(port) => port,
        None => {
            let available =
                std::net::TcpListener::bind(("127.0.0.1", DEFAULT_HARNESS_PORT)).is_ok();
            select_harness_port(None, available)
        }
    }
}

#[derive(Debug, Default)]
struct Args {
    harness: Option<PathBuf>,
    dsh_home: Option<PathBuf>,
    workspace: Option<PathBuf>,
    port: Option<u16>,
    no_window: bool,
    verbose: bool,
}

enum Action {
    Run(Args),
    Help,
    Version,
}

fn usage() -> String {
    format!(
        "dsh-desktop-rust {VERSION} — a Rust desktop wrapper for DeepSeek Harness

USAGE:
    dsh-desktop-rust [OPTIONS]

OPTIONS:
    --harness <path>   Built official Harness checkout, package install root, or
                       path to its lib/bin.js (default: bundled/local package)
    --dsh-home <dir>   Harness home directory (DSH_HOME)
                       (default: ~/.dsh)
    --workspace <dir>  Initial working directory exposed to Harness
                       (default: current directory)
    --port <n>         Harness port (default: prefer 3080, fall back if occupied;
                       use 0 for an OS-assigned port)
    --no-window        Headless mode: boot the Harness, print the ready URL, exit
    -v, --verbose      Verbose logging
    -h, --help         Show this help
    -V, --version      Show version

The wrapper boots the official open-source DeepSeek Harness framework
(https://github.com/deepseek-ai/deepseek-harness, MIT) and hosts its web GUI
in a native WebView2 window. See README.md.
"
    )
}

fn parse_args() -> Result<Action, String> {
    let mut args = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(Action::Help),
            "-V" | "--version" => return Ok(Action::Version),
            "--harness" => {
                let value = it.next().ok_or("--harness requires a value")?;
                args.harness = Some(PathBuf::from(value));
            }
            "--dsh-home" => {
                let value = it.next().ok_or("--dsh-home requires a value")?;
                args.dsh_home = Some(PathBuf::from(value));
            }
            "--workspace" => {
                let value = it.next().ok_or("--workspace requires a value")?;
                args.workspace = Some(PathBuf::from(value));
            }
            "--port" => {
                let value = it.next().ok_or("--port requires a value")?;
                args.port = Some(
                    value
                        .parse()
                        .map_err(|_| format!("invalid port: {value}"))?,
                );
            }
            "--no-window" => args.no_window = true,
            "-v" | "--verbose" => args.verbose = true,
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Action::Run(args))
}

fn main() {
    let action = match parse_args() {
        Ok(action) => action,
        Err(err) => {
            eprintln!("error: {err}\n\n{}", usage());
            std::process::exit(2);
        }
    };
    let args = match action {
        Action::Help => {
            println!("{}", usage());
            return;
        }
        Action::Version => {
            println!("dsh-desktop-rust {VERSION}");
            return;
        }
        Action::Run(args) => args,
    };

    let code = run(args);
    std::process::exit(code);
}

fn run(args: Args) -> i32 {
    let data_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("dsh-desktop-rust");
    logger::FileLogger::init(&data_dir, args.verbose);

    let state = AppState::new();

    let runtime = match runtime::discover(args.harness.as_deref()) {
        Ok(runtime) => runtime,
        Err(err) => {
            error!("{err}");
            eprintln!("error: {err}");
            eprintln!(
                "hint: run `pnpm install --frozen-lockfile` for development, use the packaged \
                 runtime, or pass --harness <path> to a built checkout."
            );
            return 1;
        }
    };
    let dsh_home = args
        .dsh_home
        .clone()
        .unwrap_or_else(runtime::default_dsh_home);
    let workspace = args
        .workspace
        .clone()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    if !workspace.is_dir() {
        error!("workspace is not a directory: {}", workspace.display());
        eprintln!(
            "error: workspace is not a directory: {}",
            workspace.display()
        );
        return 1;
    }
    info!("backend: {}", runtime.description);
    info!("DSH_HOME: {}", dsh_home.display());
    info!("workspace: {}", workspace.display());

    let port = harness_port(args.port);
    if args.port.is_none() && port == 0 {
        let message = format!(
            "default port {DEFAULT_HARNESS_PORT} is already in use; using an OS-assigned port"
        );
        warn!("{message}");
        state.push_log(format!("[shell] {message}"));
    }

    let config = HarnessConfig {
        runtime,
        dsh_home,
        workspace,
        // Prefer a stable origin so WebView2 can restore the selected session.
        // A busy default port falls back to OS assignment; explicit ports,
        // including `--port 0`, remain under the user's control.
        port: Some(port),
    };

    if args.no_window {
        return run_headless(&config, state);
    }
    match run_gui(&config, state, &data_dir) {
        Ok(()) => 0,
        Err(err) => {
            error!("{err}");
            eprintln!("error: {err}");
            1
        }
    }
}

/// Harness command loop: waits for commands and runs one lifecycle per Start.
/// A Stop ends the current lifecycle (`run_once` observes it and kills the
/// process tree) but keeps the loop alive so a later Start can restart — the
/// quit and headless paths drop the command channel to exit the loop.
fn harness_loop<F>(
    config: &HarnessConfig,
    state: &AppState,
    cmd_rx: mpsc::Receiver<HarnessCmd>,
    out_tx: mpsc::Sender<HarnessOutcome>,
    mut run_once: F,
) where
    F: FnMut(
        &HarnessConfig,
        &AppState,
        &mpsc::Receiver<HarnessCmd>,
        &mut dyn FnMut(HarnessOutcome),
    ),
{
    loop {
        match cmd_rx.recv() {
            Ok(HarnessCmd::Start) => {
                let mut report = |outcome| {
                    let _ = out_tx.send(outcome);
                };
                run_once(config, state, &cmd_rx, &mut report);
            }
            // run_once handles the Stop for the lifecycle it is running; here a
            // Stop only means "don't start a new one yet", so just keep waiting.
            Ok(HarnessCmd::Stop) => {}
            Err(_) => break,
        }
    }
}

fn run_headless(config: &HarnessConfig, state: AppState) -> i32 {
    let (cmd_tx, cmd_rx) = mpsc::channel::<HarnessCmd>();
    let (out_tx, out_rx) = mpsc::channel::<HarnessOutcome>();
    let config = config.clone();
    let state = state.clone();
    let handle = thread::spawn(move || {
        harness_loop(
            &config,
            &state,
            cmd_rx,
            out_tx,
            |config, state, cmd_rx, on_outcome| {
                harness::run_once(config, state, cmd_rx, on_outcome);
            },
        );
    });

    let _ = cmd_tx.send(HarnessCmd::Start);
    let ready_url = match out_rx.recv() {
        Ok(HarnessOutcome::Ready { url }) => {
            println!("READY {url}");
            let _ = cmd_tx.send(HarnessCmd::Stop);
            Some(url)
        }
        Ok(HarnessOutcome::Failed { reason }) => {
            println!("FAILED {reason}");
            None
        }
        Ok(HarnessOutcome::Exited { code }) => {
            println!("EXITED {code:?}");
            None
        }
        Err(_) => None,
    };
    // Close the command channel so the harness loop's `recv()` returns and the
    // thread can finish (the watcher kills the tree on Stop before returning).
    drop(cmd_tx);
    let _ = handle.join();
    if ready_url.is_some() { 0 } else { 1 }
}

fn run_gui(
    config: &HarnessConfig,
    state: AppState,
    data_dir: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    use tao::dpi::LogicalSize;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::window::WindowBuilder;
    use wry::{WebContext, WebViewBuilder};

    let event_loop = EventLoopBuilder::<AppEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title("DSH Desktop (Rust)")
        .with_inner_size(LogicalSize::new(1380.0, 900.0))
        .with_min_inner_size(LogicalSize::new(900.0, 640.0))
        .build(&event_loop)?;

    let mut web_context = WebContext::new(Some(data_dir.join("webview")));
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_custom_protocol(
            "dsh-shell".to_string(),
            protocol::handler(state.clone(), proxy.clone()),
        )
        .with_on_page_load_handler(move |event, url| {
            if matches!(event, wry::PageLoadEvent::Finished) {
                info!("webview page loaded: {url}");
            }
        })
        // Runs in the shell and Harness pages. Besides reporting successful
        // rendering, the embedded script adds the selection-to-composer flow.
        .with_initialization_script(WEBVIEW_INIT_SCRIPT)
        .with_url("dsh-shell://shell/app")
        .build(&window)?;

    let (cmd_tx, cmd_rx) = mpsc::channel::<HarnessCmd>();
    let (out_tx, out_rx) = mpsc::channel::<HarnessOutcome>();
    let config = config.clone();
    let state_for_harness = state.clone();
    let _harness_thread = thread::spawn(move || {
        harness_loop(
            &config,
            &state_for_harness,
            cmd_rx,
            out_tx,
            |config, state, cmd_rx, on_outcome| {
                harness::run_once(config, state, cmd_rx, on_outcome);
            },
        );
    });

    // Forward harness outcomes to the UI thread via the event-loop proxy.
    let _outcome_thread = {
        let proxy = proxy.clone();
        thread::spawn(move || {
            while let Ok(outcome) = out_rx.recv() {
                match outcome {
                    HarnessOutcome::Ready { url } => {
                        let _ = proxy.send_event(AppEvent::Ready { url });
                    }
                    HarnessOutcome::Failed { reason } => {
                        let _ = proxy.send_event(AppEvent::Failed { reason });
                    }
                    HarnessOutcome::Exited { code } => {
                        let reason = format!("Harness exited (code {code:?}).");
                        let _ = proxy.send_event(AppEvent::Failed { reason });
                    }
                }
            }
        })
    };

    let _ = cmd_tx.send(HarnessCmd::Start);

    // NOTE: tao's `run` returns `!` — the process exits inside it once
    // ControlFlow::Exit is set, so all shutdown work must happen in the quit
    // handlers below (kill the Harness process tree synchronously).
    let mut quitting = false;
    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(evt) => match evt {
                AppEvent::Ready { url } => {
                    info!("navigating webview to {url}");
                    let _ = webview.load_url(&url);
                }
                AppEvent::Failed { reason } => {
                    error!("harness failed: {reason}");
                    let _ = webview.load_url("dsh-shell://shell/app");
                }
                AppEvent::RestartRequested => {
                    info!("restart requested");
                    let _ = cmd_tx.send(HarnessCmd::Stop);
                    let _ = cmd_tx.send(HarnessCmd::Start);
                }
                AppEvent::QuitRequested => {
                    if !quitting {
                        quitting = true;
                        shutdown(&state, &cmd_tx);
                    }
                    *control_flow = ControlFlow::Exit;
                }
            },
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if !quitting {
                    quitting = true;
                    shutdown(&state, &cmd_tx);
                }
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

/// Synchronous shutdown: ask the harness loop to stop and kill the process
/// tree immediately (required because the tao event loop exits the process
/// before the harness thread would get to run its own cleanup).
fn shutdown(state: &AppState, cmd_tx: &mpsc::Sender<HarnessCmd>) {
    let _ = cmd_tx.send(HarnessCmd::Stop);
    if let Some(pid) = state.snapshot().pid {
        info!("killing harness process tree (pid {pid})");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/pid", &pid.to_string(), "/t", "/f"])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill")
                .arg(format!("-{pid}"))
                .status();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn test_config() -> HarnessConfig {
        HarnessConfig {
            runtime: crate::runtime::HarnessRuntime {
                program: PathBuf::from("node"),
                prefix_args: vec![OsString::from("fake-bin.js")],
                supports_no_open: true,
                startup_timeout_secs: 1,
                description: "test runtime".to_string(),
            },
            dsh_home: PathBuf::from("test-home"),
            workspace: PathBuf::from("."),
            port: Some(0),
        }
    }

    #[test]
    fn stable_port_is_the_default() {
        assert_eq!(select_harness_port(None, true), DEFAULT_HARNESS_PORT);
    }

    #[test]
    fn occupied_default_port_falls_back_to_os_assignment() {
        assert_eq!(select_harness_port(None, false), 0);
    }

    #[test]
    fn explicit_ephemeral_port_is_preserved() {
        assert_eq!(select_harness_port(Some(0), false), 0);
    }

    #[test]
    fn explicit_port_is_preserved_even_when_occupied() {
        assert_eq!(select_harness_port(Some(3080), false), 3080);
    }

    #[test]
    fn webview_script_contains_add_to_chat_integration_points() {
        assert!(WEBVIEW_INIT_SCRIPT.contains("Add to chat"));
        assert!(WEBVIEW_INIT_SCRIPT.contains("[data-chat-flow]"));
        assert!(WEBVIEW_INIT_SCRIPT.contains("[data-composer-card]"));
        assert!(WEBVIEW_INIT_SCRIPT.contains("InputEvent"));
        assert!(WEBVIEW_INIT_SCRIPT.contains("\"contextmenu\""));
        assert!(WEBVIEW_INIT_SCRIPT.contains("dshAnnotationDock"));
        assert!(WEBVIEW_INIT_SCRIPT.contains("<dsh_annotations"));
        assert!(WEBVIEW_INIT_SCRIPT.contains("dsh-source-mark"));
        assert!(!WEBVIEW_INIT_SCRIPT.contains("\"pointerup\""));
    }

    #[test]
    fn harness_loop_stays_alive_after_stop_and_restarts() {
        let config = test_config();
        let state = AppState::new();
        let (cmd_tx, cmd_rx) = mpsc::channel::<HarnessCmd>();
        let (out_tx, _out_rx) = mpsc::channel::<HarnessOutcome>();
        let starts = Arc::new(AtomicUsize::new(0));
        let starts_in_loop = starts.clone();
        let handle = thread::spawn(move || {
            harness_loop(
                &config,
                &state,
                cmd_rx,
                out_tx,
                |_config, _state, _cmd_rx, _out| {
                    starts_in_loop.fetch_add(1, Ordering::SeqCst);
                },
            );
        });
        // Regression: a Stop while the loop is idle must not end the loop, so a
        // later Start (the Retry path after a failure) can boot a new lifecycle.
        cmd_tx.send(HarnessCmd::Stop).unwrap();
        cmd_tx.send(HarnessCmd::Start).unwrap();
        cmd_tx.send(HarnessCmd::Start).unwrap();
        drop(cmd_tx);
        handle.join().unwrap();
        assert_eq!(starts.load(Ordering::SeqCst), 2);
    }
}
