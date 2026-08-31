[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Drawing.Common

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$assetRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'assets'))
$sourcePath = Join-Path $assetRoot 'dsh-desktop.svg'
$svg = [xml](Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8)

function Render-Icon {
    param(
        [Parameter(Mandatory)] [string] $Destination,
        [Parameter(Mandatory)] [int] $Size,
        [Parameter(Mandatory)] [string] $MarkColor,
        [Parameter(Mandatory)] [string] $NodeColor
    )

    $visual = [System.Windows.Media.DrawingVisual]::new()
    $context = $visual.RenderOpen()
    try {
        $scale = $Size / 512.0
        $context.PushTransform([System.Windows.Media.ScaleTransform]::new($scale, $scale))
        foreach ($element in $svg.SelectNodes('//*[local-name()="path" or local-name()="circle"]')) {
            $color = if ($element.GetAttribute('class') -eq 'node') { $NodeColor } else { $MarkColor }
            $brush = [System.Windows.Media.SolidColorBrush]::new(
                [System.Windows.Media.ColorConverter]::ConvertFromString($color)
            )
            if ($element.LocalName -eq 'path') {
                $geometry = [System.Windows.Media.Geometry]::Parse($element.GetAttribute('d'))
            }
            else {
                $center = [System.Windows.Point]::new(
                    [double]$element.GetAttribute('cx'),
                    [double]$element.GetAttribute('cy')
                )
                $radius = [double]$element.GetAttribute('r')
                $geometry = [System.Windows.Media.EllipseGeometry]::new($center, $radius, $radius)
            }
            $context.DrawGeometry($brush, $null, $geometry)
        }
        $context.Pop()
    }
    finally {
        $context.Close()
    }

    $bitmap = [System.Windows.Media.Imaging.RenderTargetBitmap]::new(
        $Size,
        $Size,
        96,
        96,
        [System.Windows.Media.PixelFormats]::Pbgra32
    )
    $bitmap.Render($visual)
    $encoder = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()
    $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [System.IO.File]::Create($Destination)
    try {
        $encoder.Save($stream)
    }
    finally {
        $stream.Dispose()
    }
}

function Export-Rgba {
    param(
        [Parameter(Mandatory)] [string] $Source,
        [Parameter(Mandatory)] [string] $Destination
    )

    $bitmap = [System.Drawing.Bitmap]::new($Source)
    try {
        $bytes = [byte[]]::new($bitmap.Width * $bitmap.Height * 4)
        $index = 0
        for ($y = 0; $y -lt $bitmap.Height; $y++) {
            for ($x = 0; $x -lt $bitmap.Width; $x++) {
                $pixel = $bitmap.GetPixel($x, $y)
                $bytes[$index] = $pixel.R
                $bytes[$index + 1] = $pixel.G
                $bytes[$index + 2] = $pixel.B
                $bytes[$index + 3] = $pixel.A
                $index += 4
            }
        }
        [System.IO.File]::WriteAllBytes($Destination, $bytes)
    }
    finally {
        $bitmap.Dispose()
    }
}

function Write-Ico {
    param(
        [Parameter(Mandatory)] [string] $Destination,
        [Parameter(Mandatory)] [string] $MarkColor,
        [Parameter(Mandatory)] [string] $NodeColor
    )

    $sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $tempDir = [System.IO.Path]::GetFullPath((Join-Path $tempRoot ([System.IO.Path]::GetRandomFileName())))
    if (-not $tempDir.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Temporary icon directory escaped the system temp directory'
    }
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    try {
        $images = foreach ($size in $sizes) {
            $png = Join-Path $tempDir "$size.png"
            Render-Icon -Destination $png -Size $size -MarkColor $MarkColor -NodeColor $NodeColor
            ,([System.IO.File]::ReadAllBytes($png))
        }

        $stream = [System.IO.File]::Create($Destination)
        $writer = [System.IO.BinaryWriter]::new($stream)
        try {
            $writer.Write([uint16]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]$sizes.Count)
            $offset = 6 + (16 * $sizes.Count)
            for ($i = 0; $i -lt $sizes.Count; $i++) {
                $sizeByte = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
                $writer.Write([byte]$sizeByte)
                $writer.Write([byte]$sizeByte)
                $writer.Write([byte]0)
                $writer.Write([byte]0)
                $writer.Write([uint16]1)
                $writer.Write([uint16]32)
                $writer.Write([uint32]$images[$i].Length)
                $writer.Write([uint32]$offset)
                $offset += $images[$i].Length
            }
            foreach ($image in $images) {
                $writer.Write($image)
            }
        }
        finally {
            $writer.Dispose()
            $stream.Dispose()
        }
    }
    finally {
        $resolvedTemp = [System.IO.Path]::GetFullPath($tempDir)
        if (-not $resolvedTemp.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to remove an icon directory outside the system temp directory'
        }
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}

$variants = @(
    @{ Name = 'light'; Mark = '#145BEB'; Node = '#18A8FF' },
    @{ Name = 'dark'; Mark = '#EAF3FF'; Node = '#67A8FF' }
)

foreach ($variant in $variants) {
    $preview = Join-Path $assetRoot "dsh-desktop-$($variant.Name).png"
    $runtime = Join-Path $assetRoot "dsh-desktop-$($variant.Name)-runtime.png"
    Render-Icon -Destination $preview -Size 512 -MarkColor $variant.Mark -NodeColor $variant.Node
    Render-Icon -Destination $runtime -Size 64 -MarkColor $variant.Mark -NodeColor $variant.Node
    Export-Rgba -Source $runtime -Destination (Join-Path $assetRoot "dsh-desktop-$($variant.Name).rgba")
    Write-Ico -Destination (Join-Path $assetRoot "dsh-desktop-$($variant.Name).ico") -MarkColor $variant.Mark -NodeColor $variant.Node
    Remove-Item -LiteralPath $runtime
}

Write-Host "Generated adaptive icon assets from $sourcePath"
