# Package for Windows

This tutorial creates and verifies a standalone Windows directory containing the Rust executable, Node.js, and the locked official DSH dependency tree.

## Prerequisites

Complete the setup in [Development](../development.md#1-install-and-check). Packaging uses the Node executable resolved from `PATH`, pnpm 11.19, and a stable Rust toolchain.

## 1. Build the Directory

From the repository root, run:

```powershell
.\scripts\package.ps1
```

The script performs a release Cargo build, creates a production-only installation from `pnpm-lock.yaml`, copies dependency files rather than linking them to the pnpm store, and adds the current `node.exe`.

Verify that the command reports this output root:

```text
target\package\DSH-Desktop
```

## 2. Verify the Embedded Runtime

Run the packaged DSH entry with the packaged Node executable:

```powershell
.\target\package\DSH-Desktop\runtime\node.exe `
  .\target\package\DSH-Desktop\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js `
  --version
```

The result must match the exact `@deepseek-ai/dsh` version in [`package.json`](../../package.json).

## 3. Smoke-Test the Wrapper

Start the packaged application without a window and with an isolated Harness home:

```powershell
.\target\package\DSH-Desktop\dsh-desktop.exe `
  --no-window `
  --dsh-home target\dsh-package-smoke `
  --workspace . `
  -v
```

Verify that the debug output names `target\package\DSH-Desktop\runtime\node.exe`, prints `READY`, and records child shutdown.

## 4. Distribute

Distribute the complete `target\package\DSH-Desktop\` directory. The executable, `runtime/node.exe`, and `runtime/node_modules/` form one application unit; copying only the executable removes its runtime.

The recipient needs Windows 10 or 11 with WebView2. A system Node.js installation and network access are not required at application startup.
