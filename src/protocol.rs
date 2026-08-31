//! `dsh-shell://` custom protocol: serves the shell page and the status/log
//! JSON endpoints used by the embedded UI, and forwards restart/quit requests
//! to the main thread through the tao event-loop proxy.

use crate::pages::SHELL_HTML;
use crate::state::AppState;
use serde::Serialize;
use std::borrow::Cow;
use tao::event_loop::EventLoopProxy;
use wry::http::{
    Request, Response,
    header::{ACCESS_CONTROL_ALLOW_ORIGIN, CACHE_CONTROL, CONTENT_TYPE},
};

pub enum AppEvent {
    Ready { url: String },
    Failed { reason: String },
    RestartRequested,
    QuitRequested,
}

#[derive(Serialize)]
struct Logs {
    logs: Vec<String>,
}

fn json_response(status: u16, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(CACHE_CONTROL, "no-store")
        .body(Cow::Owned(body))
        .expect("static json response")
}

fn html_response(body: &'static str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(200)
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(CACHE_CONTROL, "no-store")
        .body(Cow::Borrowed(body.as_bytes()))
        .expect("static html response")
}

fn text_response(status: u16, body: &'static str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(CACHE_CONTROL, "no-store")
        .body(Cow::Borrowed(body.as_bytes()))
        .expect("static text response")
}

/// Minimal percent-decoding; enough for ASCII titles.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 2 < bytes.len() {
            let hex = &input[i + 1..i + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Build the custom-protocol handler. `proxy` lets the page trigger restart
/// and quit through the main event loop.
pub fn handler(
    state: AppState,
    proxy: EventLoopProxy<AppEvent>,
) -> impl Fn(wry::WebViewId, Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> + Send + Sync + 'static
{
    move |_webview_id, request| {
        let path = request.uri().path().to_string();
        log::debug!("[protocol] {} {}", request.method(), request.uri());
        match path.as_str() {
            "/app" => html_response(SHELL_HTML),
            "/api/status" => {
                let snapshot = state.snapshot();
                json_response(200, serde_json::to_vec(&snapshot).unwrap_or_default())
            }
            "/api/logs" => {
                let n = request
                    .uri()
                    .query()
                    .and_then(|q| {
                        q.split('&').find_map(|pair| {
                            let (key, value) = pair.split_once('=')?;
                            (key == "n").then(|| value.parse::<usize>().ok()).flatten()
                        })
                    })
                    .unwrap_or(300);
                let logs = state.logs(n);
                json_response(200, serde_json::to_vec(&Logs { logs }).unwrap_or_default())
            }
            "/api/console" => {
                // Diagnostics hook: pages report their document title here.
                if let Some(query) = request.uri().query() {
                    let msg = query
                        .split('&')
                        .find_map(|pair| {
                            let (key, value) = pair.split_once('=')?;
                            (key == "msg").then(|| percent_decode(value))
                        })
                        .unwrap_or_default();
                    if !msg.is_empty() {
                        state.push_log(format!("[webview] {msg}"));
                    }
                }
                json_response(200, br#"{"ok":true}"#.to_vec())
            }
            "/api/restart" => {
                let _ = proxy.send_event(AppEvent::RestartRequested);
                json_response(200, br#"{"ok":true}"#.to_vec())
            }
            "/api/quit" => {
                let _ = proxy.send_event(AppEvent::QuitRequested);
                json_response(200, br#"{"ok":true}"#.to_vec())
            }
            _ => text_response(404, "not found"),
        }
    }
}
