# DSH-Desktop

A native Windows shell for the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI. DSH-Desktop starts the pinned `@deepseek-ai/dsh` package, waits for its loopback URL, and hosts the UI in a native window.

The application executes local DSH files directly. It does not depend on another Desktop application, invoke `npx`, or contact a package registry at runtime.

```text
┌───────────────────────────────────────────────┐
│ dsh-desktop.exe                              │
│  └─ tao window + wry WebView                 │
└───────────────────────┬───────────────────────┘
                        │ spawn / monitor / stop
                        ▼
 runtime/node.exe runtime/node_modules/
   @deepseek-ai/dsh/lib/bin.js web
   --no-open --host 127.0.0.1 --port 3080
```

Port `3080` is preferred by default so WebView2 can restore the selected session
on the next launch. If it is already occupied, the wrapper falls back to an
OS-assigned port for that launch. Pass `--port 0` to request an ephemeral origin.

## Quick Start

Development requires Windows 10 or 11 with WebView2, stable Rust, Node.js compatible with [`package.json`](package.json), and pnpm 11.19.

```powershell
pnpm install --frozen-lockfile
cargo run
```

Use an isolated Harness home for a headless lifecycle check:

```powershell
cargo run -- --no-window --dsh-home target\dsh-smoke -v
```

See [Development](docs/development.md) for prerequisites, upstream-checkout testing, and the complete validation workflow.

## Standalone Windows Package

```powershell
.\scripts\package.ps1
```

The script creates `target/package/DSH-Desktop/` with the optimized executable, Node.js, and a copied production dependency tree. Distribute the complete directory so `runtime/` remains beside the executable.

Follow [Package for Windows](docs/cookbook/package-windows.md) for verification and distribution steps.

## Documentation

The [documentation index](docs/README.md) assigns one owner to each subject:

- [Architecture](docs/architecture.md) — components, lifecycle, boundaries, and extension seams.
- [Development](docs/development.md) — contributor setup and local checks.
- [CLI reference](docs/reference/cli.md) — options, environment variables, runtime discovery, and exit behavior.
- [Documentation guidelines](docs/AGENTS.md) — document placement, writing rules, budgets, and link validation.

## License

MIT. DeepSeek Harness is also MIT-licensed. Review licenses shipped in the packaged dependency tree before redistributing a release.
