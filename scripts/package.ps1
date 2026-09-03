$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Builds the Chrome Web Store upload. Only the paths the manifest actually
# loads go in: tests, build scripts and repo docs stay out of the package.

$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $projectRoot "manifest.json") -Raw | ConvertFrom-Json

$distDirectory = Join-Path $projectRoot "dist"
$stagingDirectory = Join-Path $distDirectory "staging"
$archivePath = Join-Path $distDirectory ("hold-still-" + $manifest.version + ".zip")

$shippedPaths = @("manifest.json", "icons", "offscreen", "popup", "src")

New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null
if (Test-Path $stagingDirectory) {
    Remove-Item $stagingDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null

try {
    foreach ($shippedPath in $shippedPaths) {
        $source = Join-Path $projectRoot $shippedPath
        if (-not (Test-Path $source)) {
            throw "Missing shipped path: $shippedPath"
        }
        Copy-Item $source -Destination $stagingDirectory -Recurse -Force
    }

    if (Test-Path $archivePath) {
        Remove-Item $archivePath -Force
    }

    # Entries are written one at a time rather than with Compress-Archive or
    # ZipFile::CreateFromDirectory. Both name entries with the platform
    # separator on Windows PowerShell, and the ZIP format requires "/".
    $backslash = [char]92
    $forwardSlash = [char]47
    $prefixLength = $stagingDirectory.Length + 1

    $archive = [System.IO.Compression.ZipFile]::Open(
        $archivePath,
        [System.IO.Compression.ZipArchiveMode]::Create
    )
    try {
        foreach ($file in Get-ChildItem -Path $stagingDirectory -Recurse -File) {
            $entryName = $file.FullName.Substring($prefixLength).Replace($backslash, $forwardSlash)
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive,
                $file.FullName,
                $entryName,
                [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    }
    finally {
        $archive.Dispose()
    }
}
finally {
    if (Test-Path $stagingDirectory) {
        Remove-Item $stagingDirectory -Recurse -Force
    }
}

$sizeKb = [math]::Round((Get-Item $archivePath).Length / 1KB, 1)
Write-Output ("Packaged " + $archivePath + " (" + $sizeKb + " KB)")
