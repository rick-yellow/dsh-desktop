//! Embedded shell page shown while the Harness boots and when it fails.
//! Self-contained (no external assets); talks to the wrapper over the
//! `dsh-shell://` custom protocol.

pub const SHELL_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DSH Desktop (Rust)</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #141416; color: #e8e8e6; font-family: "Segoe UI", system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
  }
  .shell { width: min(720px, 92vw); text-align: center; }
  .brand { font-size: 26px; font-weight: 600; letter-spacing: .5px; }
  .sub { color: #9a9aa0; font-size: 13px; margin-top: 6px; }
  .spinner {
    width: 44px; height: 44px; margin: 34px auto 18px; border-radius: 50%;
    border: 3px solid #2c2c31; border-top-color: #4d9fff;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status { font-size: 15px; min-height: 22px; }
  .detail { color: #9a9aa0; font-size: 12px; margin-top: 8px; min-height: 16px; }
  .actions { margin-top: 26px; display: flex; gap: 12px; justify-content: center; }
  .actions.hidden { display: none; }
  button {
    background: #232327; color: #e8e8e6; border: 1px solid #38383e; border-radius: 8px;
    padding: 9px 20px; font-size: 14px; cursor: pointer;
  }
  button:hover { background: #2c2c31; }
  button.primary { background: #2563eb; border-color: #2563eb; }
  button.primary:hover { background: #2f6df1; }
  .log-wrap { margin-top: 26px; text-align: left; }
  .log-head { color: #9a9aa0; font-size: 12px; margin-bottom: 6px; }
  .log-head button { padding: 2px 10px; font-size: 11px; }
  pre {
    background: #101012; border: 1px solid #26262b; border-radius: 10px;
    padding: 12px; max-height: 220px; overflow: auto; font-size: 11.5px;
    line-height: 1.5; color: #b8b8bd; white-space: pre-wrap; word-break: break-all;
  }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="shell">
  <div class="brand">DeepSeek Harness</div>
  <div class="sub">dsh-desktop-rust shell</div>
  <div class="spinner" id="spinner"></div>
  <div class="status" id="status">Connecting to shell…</div>
  <div class="detail" id="detail"></div>
  <div class="log-wrap">
    <div class="log-head">Harness output <button id="toggleLog">hide</button></div>
    <pre id="log"></pre>
  </div>
  <div class="actions hidden" id="actions">
    <button id="retry" class="primary">Retry</button>
    <button id="openBrowser">Open in browser</button>
    <button id="quit">Quit</button>
  </div>
</div>
<script>
(function () {
  const $ = (id) => document.getElementById(id);
  async function getJson(path) {
    try {
      // Relative URL: this page lives at http://dsh-shell.shell/app, which wry
      // intercepts and routes back to the dsh-shell:// custom protocol.
      const r = await fetch(path, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }
  async function tick() {
    const s = await getJson("api/status");
    if (s) {
      $("status").textContent = s.message || s.phase || "";
      $("detail").textContent = s.port ? "port " + s.port + (s.elapsed_secs ? " · " + s.elapsed_secs + "s elapsed" : "") : (s.elapsed_secs ? s.elapsed_secs + "s elapsed" : "");
      const failed = s.phase === "failed";
      $("spinner").style.display = failed ? "none" : "";
      $("actions").classList.toggle("hidden", !failed);
      if (s.url) {
        $("openBrowser").onclick = () => { try { window.open(s.url, "_blank"); } catch (e) {} };
      }
    }
    const l = await getJson("api/logs?n=300");
    if (l && l.logs) {
      const el = $("log");
      el.textContent = l.logs.join("\n");
      el.scrollTop = el.scrollHeight;
    }
    setTimeout(tick, 400);
  }
  $("retry").onclick = async () => {
    $("actions").classList.add("hidden");
    $("spinner").style.display = "";
    $("status").textContent = "Restarting…";
    await getJson("api/restart");
  };
  $("quit").onclick = () => { getJson("api/quit"); };
  $("toggleLog").onclick = () => $("log").classList.toggle("hidden");
  tick();
})();
</script>
</body>
</html>
"#;
