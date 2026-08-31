use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn find_resource_compiler() -> Option<PathBuf> {
    if let Some(sdk_dir) = env::var_os("WindowsSdkDir") {
        let sdk_dir = PathBuf::from(sdk_dir);
        if let Some(version) = env::var_os("WindowsSDKVersion") {
            let candidate = sdk_dir.join("bin").join(version).join("x64").join("rc.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    let program_files = env::var_os("ProgramFiles(x86)")?;
    let bin_dir = PathBuf::from(program_files).join("Windows Kits/10/bin");
    let mut candidates = std::fs::read_dir(bin_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("x64/rc.exe"))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.cmp(left));
    candidates.into_iter().next()
}

fn version_numbers(version: &str) -> [u16; 4] {
    let mut numbers = version
        .split('.')
        .map(|part| part.parse::<u16>().unwrap_or(0));
    [
        numbers.next().unwrap_or(0),
        numbers.next().unwrap_or(0),
        numbers.next().unwrap_or(0),
        numbers.next().unwrap_or(0),
    ]
}

fn write_resource_script(path: &Path, icon: &Path, version: &str) -> std::io::Result<()> {
    let icon = icon.to_string_lossy().replace('\\', "/");
    let [major, minor, patch, build] = version_numbers(version);
    std::fs::write(
        path,
        format!(
            r#"1 ICON "{icon}"
1 VERSIONINFO
FILEVERSION {major},{minor},{patch},{build}
PRODUCTVERSION {major},{minor},{patch},{build}
FILEFLAGSMASK 0x3fL
FILEFLAGS 0x0L
FILEOS 0x40004L
FILETYPE 0x1L
FILESUBTYPE 0x0L
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904b0"
    BEGIN
      VALUE "CompanyName", "DSH-Desktop contributors"
      VALUE "FileDescription", "DSH-Desktop"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "dsh-desktop"
      VALUE "OriginalFilename", "dsh-desktop.exe"
      VALUE "ProductName", "DSH-Desktop"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x0409, 1200
  END
END
"#
        ),
    )
}

fn main() {
    println!("cargo:rerun-if-changed=assets/dsh-desktop-light.ico");
    println!("cargo:rerun-if-env-changed=WindowsSdkDir");
    println!("cargo:rerun-if-env-changed=WindowsSDKVersion");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let icon = manifest_dir.join("assets/dsh-desktop-light.ico");
    let resource_script = out_dir.join("dsh-desktop.rc");
    let compiled_resource = out_dir.join("dsh-desktop.res");
    let version = env::var("CARGO_PKG_VERSION").unwrap();
    write_resource_script(&resource_script, &icon, &version)
        .expect("write Windows application resource script");

    let compiler = find_resource_compiler()
        .expect("Windows SDK rc.exe is required to embed the DSH-Desktop application icon");
    let output = Command::new(compiler)
        .arg("/nologo")
        .arg("/fo")
        .arg(&compiled_resource)
        .arg(&resource_script)
        .output()
        .expect("run Windows SDK resource compiler");
    if !output.status.success() {
        panic!(
            "rc.exe failed:\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    println!(
        "cargo:rustc-link-arg-bin=dsh-desktop={}",
        compiled_resource.display()
    );
}
