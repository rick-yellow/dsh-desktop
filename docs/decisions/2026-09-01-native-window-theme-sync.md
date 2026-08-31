# Native Window Theme Synchronization

## Context

DeepSeek Harness owns the user-facing appearance preference and resolves `light`, `dark`, or `system` to an active color scheme in the Web page. The `tao` window title bar is outside that DOM and otherwise follows an independent native theme, which can leave a light title bar above dark Harness content.

## Decision

The WebView initialization script treats the rendered DSH scheme as the authority. It reads the root `color-scheme` value and the official `body[data-ds-dark-theme]` palette attribute, reports only `theme:light` or `theme:dark` through Wry IPC, and observes the same attributes for live changes.

Rust accepts only those two exact messages, converts them to `WindowTheme`, forwards the change through `AppEvent`, and applies the corresponding Tao window theme and icon on the event-loop thread. Windows also receives the same icon as its taskbar icon. The initial native theme and icon are dark because the embedded startup and failure shell is dark.

The wrapper does not store a second preference, modify DSH theme state, or override page colors. The Appearance setting inside DSH remains the single user control for Light, Dark, and System modes.

## Alternatives and Trade-offs

Always forcing a dark title bar matches the startup shell but fails after a user selects Light. Following only the operating-system theme ignores an explicit DSH preference. Polling the page or inferring brightness from `theme-color` metadata adds delay and makes a derived color replace DSH's explicit scheme.

Attribute observation adds a small injected integration point tied to DSH's theme presentation, while keeping theme ownership inside the official UI package.

## Consequences

The native title bar, window icon, and Windows taskbar icon change immediately after the page applies a theme and change again when the user selects another Appearance option. IPC remains limited to two inert values, and all native window mutation stays on the event-loop thread.

## Verification

Rust tests cover exact IPC message parsing, bundled icon dimensions, and required WebView integration markers. `cargo test`, `cargo clippy --all-targets --all-features -- -D warnings`, and a manual Light/Dark/System switch verify the behavior.
