//! Minimal logger: writes to stderr and an append-only log file under
//! `logs/app.log` inside the platform config directory returned by
//! `dirs::config_dir()` (e.g. `%APPDATA%/DSH-Desktop` on Windows,
//! `~/.config/DSH-Desktop` on Linux, `~/Library/Application
//! Support/DSH-Desktop` on macOS).

use log::{LevelFilter, Log, Metadata, Record};
use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Absolute path of the append-only desktop log file.
pub fn log_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join("logs").join("app.log")
}

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
        let path = log_file_path(data_dir);
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
            "=== DSH-Desktop log started (log file: {}) ===",
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

/// Export the persisted `app.log` (if any) into `target`. Returns the number
/// of bytes written. Fails when the desktop log file does not exist yet.
pub fn export_log(data_dir: &Path, target: &Path) -> std::io::Result<u64> {
    std::fs::copy(log_file_path(data_dir), target)
}

/// Default file name for an exported log, e.g. `dsh-desktop-logs-20250115-120000.log`.
pub fn export_filename_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("dsh-desktop-logs-{}.log", format_utc_from_secs(secs))
}

/// Format a Unix timestamp as UTC `YYYYMMDD-HHMMSS` (civil-from-days, Howard
/// Hinnant's algorithm) without pulling in a calendar dependency.
fn format_utc_from_secs(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if mth <= 2 { y + 1 } else { y };
    format!("{year:04}{mth:02}{d:02}-{h:02}{m:02}{s:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "dsh-desktop-logger-test-{name}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn log_file_path_points_into_logs_dir() {
        assert_eq!(
            log_file_path(Path::new("C:/data")),
            PathBuf::from("C:/data/logs/app.log")
        );
    }

    #[test]
    fn export_log_copies_the_persisted_file() {
        let tmp = TempDir::new("export");
        std::fs::create_dir_all(tmp.0.join("logs")).unwrap();
        std::fs::write(log_file_path(&tmp.0), "line one\nline two\n").unwrap();

        let target = tmp.0.join("out.log");
        let bytes = export_log(&tmp.0, &target).unwrap();
        assert_eq!(bytes, 18);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "line one\nline two\n"
        );
    }

    #[test]
    fn export_log_fails_without_a_log_file() {
        let tmp = TempDir::new("missing");
        let target = tmp.0.join("out.log");
        assert!(export_log(&tmp.0, &target).is_err());
    }

    #[test]
    fn utc_timestamp_matches_known_dates() {
        assert_eq!(format_utc_from_secs(0), "19700101-000000");
        assert_eq!(format_utc_from_secs(86_400), "19700102-000000");
        // 2025-01-15T00:00:00Z.
        assert_eq!(format_utc_from_secs(1_736_899_200), "20250115-000000");
        // 2025-01-15T12:34:56Z.
        assert_eq!(
            format_utc_from_secs(1_736_899_200 + 45_296),
            "20250115-123456"
        );
    }

    #[test]
    fn export_filename_is_prefixed_and_suffixed() {
        let name = export_filename_now();
        assert!(name.starts_with("dsh-desktop-logs-20"));
        assert!(name.ends_with(".log"));
        assert_eq!(name.len(), "dsh-desktop-logs-".len() + 15 + ".log".len());
    }
}
