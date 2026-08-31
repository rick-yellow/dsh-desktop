//! Resolves an installed official DeepSeek Harness package.
//!
//! Development uses the version locked in the repository's `pnpm-lock.yaml`.
//! Packaged builds place that same dependency tree and `node.exe` beside the
//! Rust executable under `runtime/`. Runtime discovery never invokes `npx` or
//! downloads packages.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

const NPM_PROJECT_CLI: &str = "node_modules/@deepseek-ai/dsh/lib/bin.js";
const NPM_ROOT_CLI: &str = "@deepseek-ai/dsh/lib/bin.js";
const SOURCE_CLI: &str = "apps/cli/lib/bin.js";
const PACKAGE_CLI: &str = "lib/bin.js";

#[derive(Debug, Clone)]
pub struct HarnessRuntime {
    /// Node executable bundled with the release or resolved from PATH.
    pub program: PathBuf,
    /// The official `@deepseek-ai/dsh` JavaScript entry.
    pub prefix_args: Vec<OsString>,
    /// Whether the Web app accepts `--no-open` to suppress its browser handoff.
    pub supports_no_open: bool,
    pub startup_timeout_secs: u64,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DshEntry {
    path: PathBuf,
    supports_no_open: bool,
}

pub fn default_dsh_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".dsh")
}

/// Resolve the packaged, project-local, or explicitly selected official CLI.
pub fn discover(cli_harness: Option<&Path>) -> Result<HarnessRuntime, String> {
    if let Some(root) = cli_harness {
        return resolve_local(root);
    }
    if let Ok(root) = std::env::var("DSH_HARNESS_ROOT")
        && !root.trim().is_empty()
    {
        return resolve_local(Path::new(&root));
    }

    let mut roots = Vec::new();
    if let Ok(executable) = std::env::current_exe()
        && let Some(directory) = executable.parent()
    {
        roots.push(directory.join("runtime"));
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));

    for root in unique_paths(roots) {
        if find_local_entry(&root).is_some() {
            return resolve_local(&root);
        }
    }

    Err(
        "could not find the installed official @deepseek-ai/dsh package; run `pnpm install --frozen-lockfile` for development or package the application with `scripts/package.ps1`"
            .to_string(),
    )
}

fn resolve_local(root: &Path) -> Result<HarnessRuntime, String> {
    let entry = find_local_entry(root).ok_or_else(|| {
        format!(
            "no installed official dsh CLI found under {}; expected one of {}, {}, {}, or {}",
            root.display(),
            NPM_PROJECT_CLI,
            NPM_ROOT_CLI,
            SOURCE_CLI,
            PACKAGE_CLI
        )
    })?;
    let node = find_bundled_node(root)
        .or_else(|| find_program(if cfg!(windows) { "node.exe" } else { "node" }))
        .ok_or_else(|| {
            "could not find Node.js beside the Harness runtime or on PATH".to_string()
        })?;
    Ok(HarnessRuntime {
        program: node,
        prefix_args: vec![entry.path.as_os_str().to_owned()],
        supports_no_open: entry.supports_no_open,
        startup_timeout_secs: 180,
        description: format!("official @deepseek-ai/dsh package at {}", root.display()),
    })
}

fn find_local_entry(root: &Path) -> Option<DshEntry> {
    if root.is_file() {
        return Some(DshEntry {
            path: root.to_path_buf(),
            supports_no_open: true,
        });
    }
    [
        (NPM_PROJECT_CLI, true),
        (NPM_ROOT_CLI, true),
        (SOURCE_CLI, true),
        (PACKAGE_CLI, true),
    ]
    .iter()
    .map(|(relative, supports_no_open)| DshEntry {
        path: root.join(relative),
        supports_no_open: *supports_no_open,
    })
    .find(|entry| entry.path.is_file())
}

fn find_bundled_node(root: &Path) -> Option<PathBuf> {
    let directory = if root.is_file() { root.parent()? } else { root };
    let candidate = directory.join(if cfg!(windows) { "node.exe" } else { "node" });
    candidate.is_file().then_some(candidate)
}

fn find_program(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    find_program_in(name, &path)
}

fn find_program_in(name: &str, path: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

fn unique_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths.into_iter().fold(Vec::new(), |mut unique, path| {
        if !unique.contains(&path) {
            unique.push(path);
        }
        unique
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "dsh-desktop-rust-test-{}-{name}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn create(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "// test").unwrap();
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn local_entry_accepts_published_package_layout() {
        let tmp = TempDir::new("package-project");
        let expected = tmp.create(NPM_PROJECT_CLI);
        assert_eq!(
            find_local_entry(&tmp.0),
            Some(DshEntry {
                path: expected,
                supports_no_open: true,
            })
        );
    }

    #[test]
    fn local_entry_accepts_built_source_checkout() {
        let tmp = TempDir::new("source-checkout");
        let expected = tmp.create(SOURCE_CLI);
        assert_eq!(
            find_local_entry(&tmp.0),
            Some(DshEntry {
                path: expected,
                supports_no_open: true,
            })
        );
    }

    #[test]
    fn local_entry_accepts_direct_file() {
        let tmp = TempDir::new("direct-file");
        let expected = tmp.create("custom-bin.js");
        assert_eq!(
            find_local_entry(&expected),
            Some(DshEntry {
                path: expected.clone(),
                supports_no_open: true,
            })
        );
    }

    #[test]
    fn local_entry_rejects_unbuilt_directory() {
        let tmp = TempDir::new("unbuilt");
        assert!(find_local_entry(&tmp.0).is_none());
    }

    #[test]
    fn bundled_node_wins_inside_runtime_directory() {
        let tmp = TempDir::new("bundled-node");
        let expected = tmp.create(if cfg!(windows) { "node.exe" } else { "node" });
        assert_eq!(find_bundled_node(&tmp.0), Some(expected));
    }

    #[test]
    fn program_lookup_uses_path_entries() {
        let tmp = TempDir::new("path");
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        let expected = tmp.create(name);
        assert_eq!(find_program_in(name, tmp.0.as_os_str()), Some(expected));
    }

    #[test]
    fn path_candidates_are_deduplicated() {
        assert_eq!(
            unique_paths(vec![PathBuf::from("a"), PathBuf::from("a")]),
            vec![PathBuf::from("a")]
        );
    }
}
