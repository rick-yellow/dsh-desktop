# Repository Guidelines

## Project Structure & Module Organization

This single-crate Rust 2024 application keeps CLI and `tao`/`wry` event-loop wiring in `src/main.rs`. Preserve existing module boundaries: packaged Harness resolution in `src/runtime.rs`, child-process lifecycle in `src/harness.rs`, shared status in `src/state.rs`, protocol endpoints in `src/protocol.rs`, embedded UI in `src/pages.rs`, and logging in `src/logger.rs`. `package.json` pins the official Harness; `scripts/package.ps1` assembles the standalone folder. Build output belongs in `target/`.

## Build, Test, and Development Commands

- `pnpm install --frozen-lockfile` — install the exact official Harness dependency from `pnpm-lock.yaml`.
- `cargo check` — type-check the Rust crate during development.
- `cargo run -- --help` — inspect CLI options in the debug build.
- `cargo run -- --no-window -v` — smoke-test the locally installed Harness without a WebView.
- `cargo test` — compile and run all unit and integration tests.
- `cargo fmt --all -- --check` — verify standard Rust formatting.
- `cargo clippy --all-targets --all-features -- -D warnings` — reject lint warnings before review.
- `.\scripts\package.ps1` — build the standalone Windows folder with Node and production dependencies.

Development targets recent stable Rust (currently 1.97) and Windows 10/11 with WebView2.

## Coding Style & Naming Conventions

Use `rustfmt` defaults: four-space indentation and trailing commas. Name modules, functions, and variables in `snake_case`; types and enum variants in `UpperCamelCase`; constants in `SCREAMING_SNAKE_CASE`. Prefer focused functions, explicit error messages, and module documentation for lifecycle or platform behavior. Keep platform-specific operations behind `#[cfg(windows)]` or `#[cfg(not(windows))]`.

## Testing Guidelines

Add unit tests beside the implementation in `#[cfg(test)] mod tests`; reserve `tests/*.rs` for public CLI or end-to-end behavior. Name tests after observable behavior, for example `extract_launch_url_rejects_non_loopback`. Cover runtime layouts, URL/token handling, state transitions, and failure paths without depending on a user's real Harness profile. Use an isolated `--dsh-home` for manual startup checks.

## Commit & Pull Request Guidelines

History contains one scoped, imperative-style commit (`dsh-desktop-rust: Rust desktop wrapper for DeepSeek Harness`). Follow `<scope>: <concise summary>` and keep commits focused. Pull requests should explain the change, list verification commands, link relevant issues, and include screenshots for shell-page or window changes. Call out Windows/runtime assumptions and changes to process termination, ports, tokens, or profile paths.

## Security & Configuration Tips

Never commit `node_modules/`, Harness homes, authentication tokens, generated logs, or local paths. Keep the server bound to `127.0.0.1`, and use a separate `--dsh-home` for destructive or migration testing.

## Documentation Guidelines

Use the [documentation index](docs/README.md) to locate the owning page for a subject and follow [the documentation standard](docs/AGENTS.md) for every Markdown change. Keep each durable fact in one tier, link to it elsewhere, and run `.\scripts\verify-docs.ps1` before review.
