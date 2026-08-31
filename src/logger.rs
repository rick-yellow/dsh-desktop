//! Minimal logger: writes to stderr and an append-only log file under
//! `%APPDATA%/dsh-desktop-rust/logs/app.log` (Windows) or `~/.local/share/dsh-desktop-rust/logs/app.log`.

use log::{LevelFilter, Log, Metadata, Record};
use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

pub struct FileLogger {
    file: Mutex<Option<std::fs::File>>,
}

impl FileLogger {
    pub fn init(data_dir: &Path, verbose: bool) {
        let level = if verbose {
            LevelFilter::Debug
        } else {
            LevelFilter::Info
        };
        let logs_dir = data_dir.join("logs");
        let _ = create_dir_all(&logs_dir);
        let path = logs_dir.join("app.log");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        let logger = FileLogger {
            file: Mutex::new(file),
        };
        log::set_boxed_logger(Box::new(logger))
            .map(|()| log::set_max_level(level))
            .ok();
        log::info!(
            "=== dsh-desktop-rust log started (log file: {}) ===",
            path.display()
        );
    }
}

impl Log for FileLogger {
    fn enabled(&self, _metadata: &Metadata) -> bool {
        true
    }

    fn log(&self, record: &Record) {
        let line = format!(
            "[{}] {}: {}\n",
            chrono_like_timestamp(),
            record.level().as_str().to_lowercase(),
            record.args()
        );
        eprint!("{}", line);
        let Ok(mut guard) = self.file.lock() else {
            return;
        };
        let Some(file) = guard.as_mut() else {
            return;
        };
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }

    fn flush(&self) {
        let Ok(mut guard) = self.file.lock() else {
            return;
        };
        let Some(file) = guard.as_mut() else {
            return;
        };
        let _ = file.flush();
    }
}

fn chrono_like_timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{days:04}d {h:02}:{m:02}:{s:02}")
}
