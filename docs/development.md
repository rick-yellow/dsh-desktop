# Development

This tutorial prepares a Windows development environment, runs the application, and verifies a change.

## Prerequisites

- Windows 10 or 11 with WebView2.
- Stable Rust compatible with edition 2024; the repository currently builds with Rust 1.97.
- Node.js `^22.19.0` or `>=24.0.0`.
- pnpm 11.19, matching the `packageManager` field in [`package.json`](../package.json).

## 1. Install and Check

From the repository root, install the locked official Harness dependency and type-check the Rust crate:

```powershell
pnpm install --frozen-lockfile
cargo check
```

Verify that the published DSH entry is available without `npx`:

```powershell
node .\node_modules\@deepseek-ai\dsh\lib\bin.js --version
```

The version must match the exact dependency in [`package.json`](../package.json).

## 2. Run Locally

Start the desktop window:

```powershell
cargo run
```

Use an isolated Harness home for development data:

```powershell
cargo run -- --workspace "C:\Work\project" --dsh-home "$env:TEMP\dsh-test"
```

Run a lifecycle smoke test without creating a WebView:

```powershell
cargo run -- --no-window --dsh-home target\dsh-smoke -v
```

Success prints `READY http://127.0.0.1:<port>` and exits after terminating the child process tree.

## 3. Validate a Change

Run the complete local gate:

```powershell
cargo test
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
.\scripts\verify-docs.ps1
```

Unit tests live beside their implementation in `#[cfg(test)] mod tests`. Put public CLI or end-to-end tests under `tests/` when they require the compiled crate boundary. Tests must not depend on a user's Harness profile, fixed local ports, or external network access.

## Use an Upstream Checkout

The pinned package is the normal development runtime. To test a built official source checkout, build it with its own documented pnpm workflow and pass its root explicitly:

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
cd ..\dsh-desktop-rust
cargo run -- --harness "..\deepseek-harness"
```

Runtime path formats and precedence are defined in the [CLI reference](reference/cli.md#runtime-discovery).

## Generated Files

`node_modules/` and `target/` are generated and ignored by Git. Harness homes, authentication tokens, application logs, and machine-specific paths must not be committed.
