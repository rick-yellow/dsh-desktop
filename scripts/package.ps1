[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'target\package'))
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $packageRoot 'dsh-desktop-rust'))
$runtimeRoot = Join-Path $distRoot 'runtime'

if (-not $distRoot.StartsWith($packageRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to package outside $packageRoot"
}

$cargo = Get-Command cargo -ErrorAction Stop
$pnpm = Get-Command pnpm.cmd -ErrorAction Stop
$node = Get-Command node.exe -ErrorAction Stop

Push-Location $repoRoot
try {
    & $cargo.Source build --release
    if ($LASTEXITCODE -ne 0) { throw 'cargo build --release failed' }

    if (-not (Test-Path -LiteralPath 'pnpm-lock.yaml' -PathType Leaf)) {
        throw 'pnpm-lock.yaml is missing; run pnpm install first'
    }
    if (-not (Test-Path -LiteralPath 'pnpm-workspace.yaml' -PathType Leaf)) {
        throw 'pnpm-workspace.yaml is missing'
    }

    if (Test-Path -LiteralPath $distRoot) {
        Remove-Item -LiteralPath $distRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

    Copy-Item -LiteralPath 'package.json' -Destination $runtimeRoot
    Copy-Item -LiteralPath 'pnpm-lock.yaml' -Destination $runtimeRoot
    Copy-Item -LiteralPath 'pnpm-workspace.yaml' -Destination $runtimeRoot

    & $pnpm.Source --dir $runtimeRoot install --prod --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed while assembling the runtime' }

    $dshEntry = Join-Path $runtimeRoot 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (-not (Test-Path -LiteralPath $dshEntry -PathType Leaf)) {
        throw "The packaged DSH entry is missing: $dshEntry"
    }

    Copy-Item -LiteralPath $node.Source -Destination (Join-Path $runtimeRoot 'node.exe')
    $nodeLicense = Join-Path (Split-Path -Parent $node.Source) 'LICENSE'
    if (Test-Path -LiteralPath $nodeLicense -PathType Leaf) {
        Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $runtimeRoot 'NODE-LICENSE')
    }

    Copy-Item -LiteralPath 'target\release\dsh-desktop-rust.exe' -Destination $distRoot
    Copy-Item -LiteralPath 'README.md' -Destination $distRoot
    Copy-Item -LiteralPath 'LICENSE' -Destination $distRoot

    Write-Host "Packaged standalone application: $distRoot"
    Write-Host "Harness: $dshEntry"
    Write-Host "Node: $(& (Join-Path $runtimeRoot 'node.exe') --version)"
}
finally {
    Pop-Location
}
