[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoPrefix = $repoRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$manifestPath = Join-Path $PSScriptRoot 'doc-budgets.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$failures = [System.Collections.Generic.List[string]]::new()
$budgets = @{}

foreach ($entry in $manifest.files.PSObject.Properties) {
    $budgets[$entry.Name] = [int]$entry.Value
}

$markdownFiles = @(
    Get-Item -LiteralPath (Join-Path $repoRoot 'README.md')
    Get-Item -LiteralPath (Join-Path $repoRoot 'AGENTS.md')
    Get-ChildItem -LiteralPath (Join-Path $repoRoot 'docs') -Recurse -File -Filter '*.md'
)

$actualPaths = @{}
foreach ($file in $markdownFiles) {
    $relativePath = [System.IO.Path]::GetRelativePath($repoRoot, $file.FullName).Replace('\', '/')
    $actualPaths[$relativePath] = $true
    if (-not $budgets.ContainsKey($relativePath)) {
        $failures.Add("Missing word budget: $relativePath")
        continue
    }

    $content = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
    $wordCount = [regex]::Matches($content, "[\p{L}\p{N}][\p{L}\p{N}'_-]*").Count
    if ($wordCount -gt $budgets[$relativePath]) {
        $failures.Add("Word budget exceeded: $relativePath has $wordCount words; limit is $($budgets[$relativePath])")
    }

    foreach ($linkMatch in [regex]::Matches($content, '!?' + '\[[^\]]*\]\((?<target>[^)]+)\)')) {
        $rawTarget = $linkMatch.Groups['target'].Value.Trim()
        if ($rawTarget.StartsWith('<') -and $rawTarget.EndsWith('>')) {
            $rawTarget = $rawTarget.Substring(1, $rawTarget.Length - 2)
        } else {
            $rawTarget = ($rawTarget -split '\s+', 2)[0]
        }
        if ($rawTarget -match '^[a-zA-Z][a-zA-Z0-9+.-]*:') {
            continue
        }

        $parts = $rawTarget -split '#', 2
        $pathPart = [System.Uri]::UnescapeDataString($parts[0])
        $targetPath = if ($pathPart) {
            [System.IO.Path]::GetFullPath((Join-Path $file.DirectoryName $pathPart))
        } else {
            $file.FullName
        }
        if (-not $targetPath.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            $failures.Add("Link escapes repository: $relativePath -> $rawTarget")
            continue
        }
        if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
            $failures.Add("Broken link: $relativePath -> $rawTarget")
            continue
        }

        if ($parts.Count -eq 2 -and $parts[1]) {
            $fragment = [System.Uri]::UnescapeDataString($parts[1]).ToLowerInvariant()
            $targetContent = Get-Content -LiteralPath $targetPath -Raw -Encoding UTF8
            $anchors = foreach ($heading in [regex]::Matches($targetContent, '(?m)^#{1,6}\s+(?<text>.+?)\s*#*\s*$')) {
                $anchor = $heading.Groups['text'].Value.ToLowerInvariant()
                $anchor = [regex]::Replace($anchor, '[`*_~]', '')
                $anchor = [regex]::Replace($anchor, '[^\p{L}\p{N}\s_-]', '')
                $anchor = [regex]::Replace($anchor, '\s+', '-')
                [regex]::Replace($anchor, '-+', '-').Trim('-')
            }
            if ($fragment -notin $anchors) {
                $failures.Add("Missing link fragment: $relativePath -> $rawTarget")
            }
        }
    }
}

foreach ($budgetPath in $budgets.Keys) {
    if (-not $actualPaths.ContainsKey($budgetPath)) {
        $failures.Add("Budget references a missing Markdown file: $budgetPath")
    }
}

if ($failures.Count -gt 0) {
    foreach ($failure in $failures) {
        Write-Host "ERROR: $failure" -ForegroundColor Red
    }
    exit 1
}

Write-Host "Documentation checks passed for $($markdownFiles.Count) Markdown files."
