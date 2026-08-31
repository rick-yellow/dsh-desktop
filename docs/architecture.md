# Architecture

This reference maps the application composition, startup lifecycle, ownership boundaries, and extension seams. Read the [CLI reference](reference/cli.md) for exact options and lookup order.

## Composition

DSH-Desktop is a single Rust 2024 executable that embeds a native `tao` window and a `wry` WebView while running the official `@deepseek-ai/dsh` web CLI as a child process.

| Component | Responsibility |
| --- | --- |
| [`src/main.rs`](../src/main.rs) | Parse CLI arguments, construct application state, and own the GUI event loop. |
| [`src/runtime.rs`](../src/runtime.rs) | Resolve the packaged, project-local, or explicitly selected DSH JavaScript entry and Node executable. |
| [`src/harness.rs`](../src/harness.rs) | Spawn DSH, detect readiness and failures, stream output, and terminate the process tree. |
| [`src/state.rs`](../src/state.rs) | Store lifecycle phase, launch metadata, and bounded logs shared by worker and UI threads. |
| [`src/protocol.rs`](../src/protocol.rs) | Serve the internal `dsh-shell://` status and control protocol, including log-export requests. |
| [`src/pages.rs`](../src/pages.rs) | Provide embedded startup and failure HTML, CSS, and JavaScript, including the log-export button. |
| [`src/webview.js`](../src/webview.js) | Add desktop-only page behavior, including composer annotations and native-window theme reporting. |
| [`src/logger.rs`](../src/logger.rs) | Write diagnostic output to stderr and the application log file, and export that file on request. |
| [`assets/dsh-desktop.svg`](../assets/dsh-desktop.svg) | Define the original adaptive application mark used to generate light and dark window assets. |
| [`build.rs`](../build.rs) | Compile the default Windows application icon into the executable. |

## Startup Lifecycle

1. `main` parses arguments and resolves a `HarnessRuntime`.
2. The harness worker starts Node with the resolved `lib/bin.js web` entry, `--no-open`, loopback host, selected port, workspace, and `DSH_HOME`.
3. Reader threads stream stdout and stderr into shared state while scanning for the `dsh web:` launch line or a startup failure marker.
4. Headless mode prints `READY`, requests shutdown, and exits. GUI mode navigates the WebView to the authenticated loopback URL.
5. A stop request or window close terminates the complete child-process tree before the worker exits.

Channels separate lifecycle work from the GUI event loop: `HarnessCmd` carries start and stop requests, while `HarnessOutcome` carries readiness, failure, and exit results.

The GUI prefers port `3080` so WebView2 keeps the same origin and can restore its current-session selection from local storage. When the default port is occupied, the wrapper falls back to OS assignment for that launch; an explicit port remains strict, and an explicit `--port 0` always requests a fresh browser origin.

## Runtime Distribution

Development uses the dependency pinned by [`package.json`](../package.json) and [`pnpm-lock.yaml`](../pnpm-lock.yaml). A standalone release places `node.exe` and the copied production dependency tree under `runtime/` beside the Rust executable. The wrapper executes these local files directly and performs no package-manager operation at runtime.

The exact discovery order and supported directory layouts belong to the [CLI reference](reference/cli.md#runtime-discovery).

## Security Boundaries

The child server binds to `127.0.0.1`. The authenticated URL emitted by DSH is forwarded unchanged to the WebView, and the wrapper does not persist its token separately.

`DSH_HOME` owns Harness state and credentials. Tests and manual experiments use an isolated home rather than a user's primary profile. The selected workspace becomes the child process working directory and must already exist.

## Window Theme Synchronization

DSH owns the Light, Dark, and System appearance preference. The injected WebView script observes the resolved `color-scheme` and `data-ds-dark-theme` state, sends an exact light or dark IPC message, and the event loop applies the matching Tao window theme, title-bar icon, and Windows taskbar icon. The wrapper does not persist or override the DSH preference; the [decision record](decisions/2026-09-01-native-window-theme-sync.md) owns the rationale and trade-offs.

## Extension Seams

Add runtime layouts in `runtime.rs`, process behavior in `harness.rs`, shared lifecycle data in `state.rs`, and shell-only UI operations in `protocol.rs`. Keep DSH product behavior inside the official package instead of duplicating it in the desktop wrapper.
