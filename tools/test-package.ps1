#Requires -Version 5.1
[CmdletBinding()]
param([string]$HubPackagePath)
if ([string]::IsNullOrWhiteSpace($HubPackagePath)) { $HubPackagePath = Join-Path (Split-Path -Parent $PSScriptRoot) '.local-deps\dsh-plugin-hub-1.0.0-win-x64.zip' }
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'portable.ps1') -Library
function Assert-PackageTest([bool]$Condition, [string]$Message) { if (-not $Condition) { throw ('PACKAGE TEST FAILED: ' + $Message) } }
$testBoundary = Get-MediaAbsolutePath $(if ($env:DSH_TEST_TEMP) { $env:DSH_TEST_TEMP } else { [IO.Path]::GetTempPath() })
$testRoot = Assert-MediaChildPath (Join-Path $testBoundary ('media-pack-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))) $testBoundary
$packageFixture = Join-Path $testRoot 'fixture source'
$outputFixture = Join-Path $testRoot 'fixture output'
$defaultOutputFixture = Join-Path $testRoot 'default-root fixture output'
$success = $false
New-Item -ItemType Directory -Path (Join-Path $packageFixture 'lib'), (Join-Path $packageFixture 'delivery') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $packageFixture 'tools') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'package.ps1') -Destination (Join-Path $packageFixture 'tools\package.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable.ps1') -Destination (Join-Path $packageFixture 'tools\portable.ps1')
Write-MediaUtf8 (Join-Path $packageFixture 'package.json') '{"name":"dsh-media-reader","version":"1.0.0","type":"module","files":["lib","vendor","cordis.patch.yml","README.md","LICENSE"]}'
Write-MediaUtf8 (Join-Path $packageFixture 'cordis.patch.yml') '- insert: []'
Write-MediaUtf8 (Join-Path $packageFixture 'lib\index.js') 'export function apply() {}'
Write-MediaUtf8 (Join-Path $packageFixture 'lib\client.js') '/* prebuilt client fixture */'
Write-MediaUtf8 (Join-Path $packageFixture 'lib\media.js') '/* prebuilt media fixture */'
foreach ($relative in @('vendor\ffmpeg\bin\ffmpeg.exe', 'vendor\ffmpeg\bin\ffprobe.exe', 'vendor\ffmpeg\bin\avcodec-62.dll', 'vendor\ffmpeg\bin\avdevice-62.dll', 'vendor\ffmpeg\bin\avfilter-11.dll', 'vendor\ffmpeg\bin\avformat-62.dll', 'vendor\ffmpeg\bin\avutil-60.dll', 'vendor\ffmpeg\bin\swresample-6.dll', 'vendor\ffmpeg\bin\swscale-9.dll', 'vendor\ffmpeg\LICENSE.txt', 'vendor\ffmpeg\source\ffmpeg-source.tar.gz', 'vendor\ffmpeg\source\ffmpeg-build-scripts.tar.gz')) {
    $target = Join-Path $packageFixture $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Write-MediaUtf8 $target 'isolated packaging fixture, never executed'
}
Write-MediaUtf8 (Join-Path $packageFixture 'README.md') '# Fixture'
Write-MediaUtf8 (Join-Path $packageFixture 'LICENSE') 'Fixture license'
foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'delivery') -File)) {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $packageFixture ('delivery\' + $file.Name))
}
try {
    $result = & (Join-Path $PSScriptRoot 'package.ps1') -PackageRoot $packageFixture -OutputDirectory $outputFixture -HubPackagePath $HubPackagePath
    Assert-PackageTest (Test-Path -LiteralPath $result.PackagePath -PathType Leaf) 'ZIP was not written.'
    Assert-PackageTest ($result.Sha256 -eq (Get-FileHash -LiteralPath $result.PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()) 'ZIP hash mismatch.'
    # Exercise the documented entry path with no -PackageRoot argument.
    $defaultResult = & (Join-Path $packageFixture 'tools\package.ps1') -OutputDirectory $defaultOutputFixture -HubPackagePath $HubPackagePath
    Assert-PackageTest (Test-Path -LiteralPath $defaultResult.PackagePath -PathType Leaf) 'Default package root was not resolved in the script body.'
    Assert-PackageTest ($defaultResult.PackagePath.StartsWith($defaultOutputFixture, [StringComparison]::OrdinalIgnoreCase)) 'Default-root test wrote outside its isolated output directory.'
    $archive = [IO.Compression.ZipFile]::OpenRead($result.PackagePath)
    try {
        $entries = @($archive.Entries)
        $names = @($entries | ForEach-Object { $_.FullName })
        Assert-PackageTest (@($names | Where-Object { $_.Contains('\') }).Count -eq 0) 'A ZIP entry uses a Windows backslash instead of a standard forward slash.'
        Assert-PackageTest ($names -contains 'plugin/lib/client.js') 'Built client is absent.'
        Assert-PackageTest ($names -contains 'tools/portable.ps1') 'Portable installer is absent.'
        Assert-PackageTest ($names -contains 'plugin/lib/media.js') 'Media implementation is absent.'
        Assert-PackageTest ($names -contains 'plugin/vendor/ffmpeg/bin/ffmpeg.exe' -and $names -contains 'plugin/vendor/ffmpeg/bin/ffprobe.exe') 'Bundled decoder is absent.'
        Assert-PackageTest ($names -contains 'plugin/vendor/ffmpeg/source/ffmpeg-source.tar.gz') 'Corresponding source archive is absent.'
        Assert-PackageTest ($names -contains 'dependencies/dsh-plugin-hub-1.0.0-win-x64.zip') 'Portable pocket dependency is absent.'
        Assert-PackageTest ($names -contains 'SHA256SUMS.txt') 'Per-file hashes are absent.'
        Assert-PackageTest (@($names | Group-Object | Where-Object { $_.Count -gt 1 }).Count -eq 0) 'ZIP has duplicate entries.'
        $documents = @($entries | Where-Object { $_.FullName -notlike '*/*' -and $_.Name -like '*.txt' -and $_.Name -ne 'SHA256SUMS.txt' })
        Assert-PackageTest ($documents.Count -eq 1) 'The UTF-8 user instructions are absent or duplicated.'
        $documentStream = $documents[0].Open()
        $documentReader = New-Object IO.StreamReader($documentStream, (New-Object Text.UTF8Encoding($false, $true)))
        try { $documentText = $documentReader.ReadToEnd() } finally { $documentReader.Dispose() }
        Assert-PackageTest ($documentText.Contains('dsh-media-reader') -and $documentText.Contains([string][char]0x63D2 + [char]0x4EF6)) 'Chinese TXT content did not round-trip.'
        $launchers = @($entries | Where-Object { $_.Name -like '*.cmd' })
        Assert-PackageTest ($launchers.Count -eq 3) 'Expected three launchers.'
        foreach ($entry in $launchers) {
            $stream = $entry.Open()
            $memory = New-Object IO.MemoryStream
            try { $stream.CopyTo($memory); $bytes = $memory.ToArray() } finally { $stream.Dispose(); $memory.Dispose() }
            Assert-PackageTest (@($bytes | Where-Object { $_ -gt 127 }).Count -eq 0) 'A launcher is not ASCII.'
            $text = [Text.Encoding]::ASCII.GetString($bytes)
            Assert-PackageTest (-not $text.Replace("`r`n", '').Contains("`n")) 'A launcher does not use CRLF.'
        }
        $hashEntry = @($entries | Where-Object { $_.FullName -eq 'SHA256SUMS.txt' })[0]
        $hashReader = New-Object IO.StreamReader($hashEntry.Open(), [Text.Encoding]::UTF8)
        try { $hashLines = $hashReader.ReadToEnd().Split("`n") | Where-Object { $_ } } finally { $hashReader.Dispose() }
        foreach ($line in $hashLines) {
            $hash = $line.Substring(0, 64)
            $name = $line.Substring(66).TrimEnd("`r")
            $entry = @($entries | Where-Object { $_.FullName -eq $name })[0]
            Assert-PackageTest ($null -ne $entry) ('Hash list names a missing file: ' + $name)
            $stream = $entry.Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }
            Assert-PackageTest ($actual -eq $hash) ('Per-file hash mismatch: ' + $name)
        }
    } finally { $archive.Dispose() }
    try {
        & (Join-Path $PSScriptRoot 'package.ps1') -PackageRoot $packageFixture -OutputDirectory $outputFixture -HubPackagePath $HubPackagePath | Out-Null
        throw 'PACKAGE TEST FAILED: existing release was overwritten.'
    } catch {
        if ($_.Exception.Message -notlike '*already exists*') { throw }
    }
    $success = $true
    Write-Host 'Packaging fixture passed: default-root invocation, standard slash-only ZIP entries, UTF-8 instructions, ASCII/CRLF launchers, all file hashes and overwrite refusal.'
} finally {
    if ($success) { Remove-MediaOwnedDirectory $testRoot $testBoundary }
    else { Write-Host ('Package fixture retained for diagnosis: ' + $testRoot) }
}
