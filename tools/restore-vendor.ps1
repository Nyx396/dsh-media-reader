#Requires -Version 5.1
[CmdletBinding()]
param([string]$ReleaseZip, [string]$PackageRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'portable.ps1') -Library
if ([string]::IsNullOrWhiteSpace($PackageRoot)) { $PackageRoot = Split-Path -Parent $PSScriptRoot }
$PackageRoot = Get-MediaAbsolutePath $PackageRoot
$manifest = Read-MediaJson (Join-Path $PackageRoot 'vendor\ffmpeg\release-manifest.json')
if ($manifest.schemaVersion -ne 1 -or $manifest.releaseSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Unsupported vendor manifest.' }
if ([string]::IsNullOrWhiteSpace($ReleaseZip)) { $ReleaseZip = Join-Path (Split-Path -Parent $PackageRoot) $manifest.releaseFile }
$ReleaseZip = Get-MediaAbsolutePath $ReleaseZip
if (-not (Test-Path -LiteralPath $ReleaseZip -PathType Leaf)) { throw 'Download the media-reader release ZIP, then pass -ReleaseZip <absolute ZIP path>.' }
if ((Get-FileHash -LiteralPath $ReleaseZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.releaseSha256) { throw 'Release ZIP SHA256 mismatch. No files restored.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($ReleaseZip)
$stageRoot = Join-Path $PackageRoot 'tools\out'
Assert-MediaNoLinkedAncestors $stageRoot $PackageRoot
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
$stage = Assert-MediaChildPath (Join-Path $stageRoot ('vendor-' + [Guid]::NewGuid().ToString('N'))) $stageRoot
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    # Validate all selected files in staging before changing any destination.
    $operations = @()
    foreach ($item in $manifest.files) {
        if ($item.relativePath -notmatch '^(vendor/ffmpeg/(bin|source)/[^/]+|[.]local-deps/[^/]+)$' -or $item.relativePath -match '\\|(^|/)\.\.(/|$)' -or $item.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Unsafe vendor manifest entry.' }
        $matches = @($archive.Entries | Where-Object { $_.FullName -ceq $item.archivePath })
        if ($matches.Count -ne 1 -or $matches[0].Length -ne $item.bytes) { throw ('Missing or unexpected ZIP member: ' + $item.archivePath) }
        $destination = Assert-MediaChildPath (Join-Path $PackageRoot $item.relativePath) $PackageRoot
        Assert-MediaNoLinkedAncestors $destination $PackageRoot
        if (Test-Path -LiteralPath $destination) {
            if (-not (Test-Path -LiteralPath $destination -PathType Leaf) -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) { throw ('Existing file differs; refusing to overwrite: ' + $item.relativePath) }
            continue
        }
        $staged = Assert-MediaChildPath (Join-Path $stage $item.relativePath) $stage
        New-Item -ItemType Directory -Path (Split-Path -Parent $staged) -Force | Out-Null
        $inputStream = $matches[0].Open()
        $outputStream = [IO.File]::Open($staged, [IO.FileMode]::CreateNew)
        try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
        if ((Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) { throw ('Vendor file SHA256 mismatch: ' + $item.relativePath) }
        $operations += [pscustomobject]@{ Source = $staged; Destination = $destination }
    }
    foreach ($operation in $operations) {
        Assert-MediaNoLinkedAncestors $operation.Destination $PackageRoot
        New-Item -ItemType Directory -Path (Split-Path -Parent $operation.Destination) -Force | Out-Null
        [IO.File]::Move($operation.Source, $operation.Destination)
    }
    Write-Host ('Restored ' + $operations.Count + ' files. Existing identical files were preserved.')
    Write-Host 'Only local development dependencies were restored. No DSH profile was modified.'
} finally {
    $archive.Dispose()
    if (Test-Path -LiteralPath $stage) { Remove-MediaOwnedDirectory $stage $stageRoot }
}
