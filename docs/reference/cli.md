# CLI Reference

This reference defines command-line options, environment variables, runtime discovery, output, and exit behavior for `dsh-desktop-rust`.

## Usage

```text
dsh-desktop-rust [OPTIONS]
```

| Option | Contract |
| --- | --- |
| `--harness <path>` | Select a built official checkout, package installation root, or direct `lib/bin.js` file. |
| `--dsh-home <dir>` | Set the Harness state directory exposed as `DSH_HOME`; defaults to `~/.dsh`. |
| `--workspace <dir>` | Set the existing working directory exposed to Harness; defaults to the current directory. |
| `--port <n>` | Request a specific DSH port; defaults to `3080`. Pass `0` for OS assignment. |
| `--no-window` | Start DSH, report readiness or failure, terminate it, and exit without a WebView. |
| `-v`, `--verbose` | Enable debug-level diagnostic output. |
| `-h`, `--help` | Print usage and exit. |
| `-V`, `--version` | Print the wrapper version and exit. |

Unknown options, missing values, and invalid ports print an error plus usage and exit with code `2`.

## Environment

`DSH_HARNESS_ROOT` supplies the same runtime override as `--harness`; the command-line option takes precedence. The selected `--dsh-home` value is passed to the child process as `DSH_HOME`.

## Runtime Discovery

The wrapper selects the first valid runtime in this order:

1. The path supplied by `--harness`.
2. The non-empty `DSH_HARNESS_ROOT` value.
3. A `runtime/` directory beside the running executable.
4. The Cargo manifest directory embedded at compile time.

A selected directory may contain any of these entries:

1. `node_modules/@deepseek-ai/dsh/lib/bin.js` for the project or packaged dependency layout.
2. `@deepseek-ai/dsh/lib/bin.js` when the package directory itself is selected.
3. `apps/cli/lib/bin.js` for a built upstream checkout.
4. `lib/bin.js` for a direct published-package root.

A direct file path is also accepted. The wrapper uses `node.exe` or `node` beside the selected runtime when present, otherwise it resolves Node from `PATH`. Packaged releases therefore select their bundled Node before any system installation.

## Headless Output and Exit Codes

Headless mode prints one of these records to stdout:

```text
READY http://127.0.0.1:<port>
FAILED <reason>
EXITED <optional-code>
```

`READY` exits with code `0` after shutdown. Startup failure, premature child exit, invalid workspace, runtime discovery failure, or GUI initialization failure exits with code `1`.

## Child Command

The child command is equivalent to:

```text
node <dsh-entry> web --no-open --host 127.0.0.1 --port <port>
```

All supported official layouts receive `--no-open`, keeping the GUI inside the desktop WebView. The stable default port preserves the WebView origin and its persisted current-session selection across application launches.
