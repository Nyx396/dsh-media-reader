#Requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'portable.ps1') -Library
function Get-MediaDshProcesses { return @() }
function Assert-Test([bool]$Condition, [string]$Message) { if (-not $Condition) { throw ('TEST FAILED: ' + $Message) } }
function Assert-Throws([scriptblock]$Action, [string]$Expected) {
    try { & $Action | Out-Null } catch {
        if ($_.Exception.Message -like ('*' + $Expected + '*')) { return }
        throw ('TEST FAILED: wrong error. Expected ' + $Expected + '; got ' + $_.Exception.Message)
    }
    throw ('TEST FAILED: expected an error containing ' + $Expected)
}

$testBoundary = Get-MediaAbsolutePath $(if ($env:DSH_TEST_TEMP) { $env:DSH_TEST_TEMP } else { [IO.Path]::GetTempPath() })
$testRoot = Assert-MediaChildPath (Join-Path $testBoundary ('media-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))) $testBoundary
$unicodeName = [string][char]0x63D2 + [char]0x4EF6 + ' path with spaces'
$fixture = Join-Path $testRoot $unicodeName
$fixtureHome = Join-Path $fixture '.dsh isolated'
$source = Join-Path $fixture 'release source'
$profilePath = Join-Path $fixtureHome 'profiles\desktop'
$manifestPath = Join-Path $profilePath 'package.json'
$fakeCli = Join-Path $fixture 'fake dsh.ps1'
$success = $false
$savedTestFail = $env:MEDIA_TEST_FAIL_MODE
$savedDshHome = $env:DSH_HOME
$savedOffline = $env:npm_config_offline
$savedIgnoreScripts = $env:npm_config_ignore_scripts
$savedTestVersion = $env:MEDIA_TEST_DSH_VERSION
New-Item -ItemType Directory -Path (Join-Path $source 'lib'), $profilePath -Force | Out-Null
Write-MediaUtf8 (Join-Path $source 'package.json') '{"name":"dsh-media-reader","version":"1.0.0","type":"module","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}'
Write-MediaUtf8 (Join-Path $source 'cordis.patch.yml') '- insert: []'
Write-MediaUtf8 (Join-Path $source 'lib\index.js') 'export function apply() {}'
Write-MediaUtf8 (Join-Path $source 'lib\client.js') '/* prebuilt client fixture */'
Write-MediaUtf8 (Join-Path $source 'lib\media.js') '/* media fixture */'
foreach ($relative in @('vendor\ffmpeg\bin\ffmpeg.exe', 'vendor\ffmpeg\bin\ffprobe.exe', 'vendor\ffmpeg\bin\avcodec-62.dll', 'vendor\ffmpeg\bin\avdevice-62.dll', 'vendor\ffmpeg\bin\avfilter-11.dll', 'vendor\ffmpeg\bin\avformat-62.dll', 'vendor\ffmpeg\bin\avutil-60.dll', 'vendor\ffmpeg\bin\swresample-6.dll', 'vendor\ffmpeg\bin\swscale-9.dll', 'vendor\ffmpeg\LICENSE.txt', 'vendor\ffmpeg\source\ffmpeg-source.tar.gz', 'vendor\ffmpeg\source\ffmpeg-build-scripts.tar.gz')) {
    $target = Join-Path $source $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Write-MediaUtf8 $target 'isolated fixture, never executed'
}
Write-MediaUtf8 $manifestPath '{"name":"profile-test","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","other-plugin","dsh-plugin-hub"]}},"dependencies":{"other-plugin":"link:D:/an unrelated place","dsh-plugin-hub":"link:D:/existing hub"},"customSetting":{"keep":"unchanged","nested":{"alpha":1,"zeta":2},"sequence":["alpha","beta"]}}'
$hubManifestPath = Join-Path $profilePath 'node_modules\dsh-plugin-hub\package.json'
New-Item -ItemType Directory -Path (Split-Path -Parent $hubManifestPath) -Force | Out-Null
Write-MediaUtf8 $hubManifestPath '{"name":"dsh-plugin-hub","version":"1.0.0"}'
Write-MediaUtf8 (Join-Path $profilePath 'cordis.patch.yml') "# unrelated user patch`n- id: kept-setting`n"
Write-MediaUtf8 (Join-Path $profilePath 'pnpm-workspace.yaml') "packages:`n  - .`nautoInstallPeers: false`n"
$mockSource = @'
$ErrorActionPreference = 'Stop'
if ($args -contains '--version') {
    if ($env:MEDIA_TEST_DSH_VERSION) { Write-Output $env:MEDIA_TEST_DSH_VERSION } else { Write-Output '0.2.1-rc.2' }
    $global:LASTEXITCODE = 0
    return
}
if ($args -notcontains '--offline' -or $args -notcontains '--ignore-scripts') { throw 'Mock requires explicit offline and no-script arguments.' }
if ($env:npm_config_offline -ne 'true' -or $env:npm_config_ignore_scripts -ne 'true') { throw 'Mock requires inherited offline and no-script configuration.' }
$profileIndex = [Array]::IndexOf($args, '--profile')
$profile = $args[$profileIndex + 1]
$operation = $args[$profileIndex + 2]
$value = $args[$profileIndex + 3]
$dir = Join-Path $env:DSH_HOME ('profiles\' + $profile)
$path = Join-Path $dir 'package.json'
$manifest = [IO.File]::ReadAllText($path) | ConvertFrom-Json
$name = 'dsh-media-reader'
$nodeLink = Join-Path $dir ('node_modules\' + $name)
$existing = Get-Item -LiteralPath $nodeLink -Force -ErrorAction SilentlyContinue
if ($existing) {
    if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { [IO.Directory]::Delete($nodeLink, $false) }
    else { Remove-Item -LiteralPath $nodeLink -Recurse -Force }
}
if ($operation -eq 'add') {
    $target = $value.Substring('link:'.Length)
    if (-not $manifest.dependencies) { $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
    $manifest.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force
    if (@($manifest.dsh.profile.bundles) -notcontains $name) { $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles) + $name }
    New-Item -ItemType Directory -Path (Split-Path -Parent $nodeLink) -Force | Out-Null
    # A normal directory fixture avoids requiring junction privileges in CI.
    # The real DSH CLI creates and owns its actual node_modules link.
    Copy-Item -LiteralPath $target -Destination $nodeLink -Recurse
} elseif ($operation -eq 'remove') {
    $manifest.dependencies.PSObject.Properties.Remove($name)
    $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles | Where-Object { $_ -ne $name })
} else { throw ('Unexpected operation: ' + $operation) }
if ($env:MEDIA_TEST_FAIL_MODE -eq 'unrelated') { $manifest.customSetting.keep = 'unexpected mutation' }
if ($env:MEDIA_TEST_FAIL_MODE -eq 'arrayorder') { $manifest.customSetting.sequence = @('beta', 'alpha') }
if ($env:MEDIA_TEST_FAIL_MODE -eq 'reorder') {
    $manifest.customSetting.nested = [pscustomobject][ordered]@{ zeta = 2; alpha = 1 }
    $manifest.customSetting = [pscustomobject][ordered]@{ sequence = $manifest.customSetting.sequence; nested = $manifest.customSetting.nested; keep = $manifest.customSetting.keep }
    $reordered = [ordered]@{}
    foreach ($property in @($manifest.PSObject.Properties | Sort-Object Name -Descending)) { $reordered[$property.Name] = $property.Value }
    $manifest = [pscustomobject]$reordered
}
[IO.File]::WriteAllText($path, ($manifest | ConvertTo-Json -Depth 50), (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $dir 'pnpm-lock.yaml'), '# mock updated lock', (New-Object Text.UTF8Encoding($false)))
if ($env:MEDIA_TEST_FAIL_MODE -eq 'exit') {
    # Simulate DSH's repair subprocess: it gets no original pnpm flags.
    $executable = if ($PSVersionTable.PSVersion.Major -ge 6) { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }
    $repairCommand = 'if ($env:npm_config_offline -ne ''true'' -or $env:npm_config_ignore_scripts -ne ''true'') { exit 31 }; exit 0'
    & $executable -NoProfile -NonInteractive -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($repairCommand)))
    if ($LASTEXITCODE -ne 0) { throw 'Repair subprocess lost offline/no-script configuration.' }
    $global:LASTEXITCODE = 23
    return
}
$global:LASTEXITCODE = 0
'@
Write-MediaUtf8 $fakeCli $mockSource
$parameters = @{ DshPath = $fakeCli; DshHome = $fixtureHome; Profile = 'desktop'; PluginSource = $source }
try {
    $env:MEDIA_TEST_DSH_VERSION = '0.2.2'
    Assert-Throws { Invoke-MediaDeployment -Mode Install @parameters } 'requires DSH 0.2.1-rc.2'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $fixtureHome 'backups'))) 'Version refusal created a backup.'
    $env:MEDIA_TEST_DSH_VERSION = $null
    $validManifest = [IO.File]::ReadAllText($manifestPath)
    $missingHub = Read-MediaJson $manifestPath
    $missingHub.dependencies.PSObject.Properties.Remove('dsh-plugin-hub')
    Write-MediaUtf8 $manifestPath ($missingHub | ConvertTo-Json -Depth 50)
    Assert-Throws { Invoke-MediaDeployment -Mode Install @parameters } 'dsh-plugin-hub is missing'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $fixtureHome 'backups'))) 'Missing dependency refusal created a backup.'
    Write-MediaUtf8 $manifestPath $validManifest
    Write-MediaUtf8 $hubManifestPath '{"name":"dsh-plugin-hub","version":"2.0.0"}'
    Assert-Throws { Invoke-MediaDeployment -Mode Install @parameters } 'requires dsh-plugin-hub 1.0.0'
    Write-MediaUtf8 $hubManifestPath '{"name":"dsh-plugin-hub","version":"1.0.0"}'
    Write-Host '[PASS] host version and missing/incompatible dependency are refused before mutation'

    $beforeCheck = [IO.File]::ReadAllText($manifestPath)
    $check = Invoke-MediaDeployment -Mode Check @parameters
    Assert-Test ([IO.File]::ReadAllText($manifestPath) -eq $beforeCheck) 'Check changed profile metadata.'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $fixtureHome 'backups'))) 'Check created backup directories.'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $fixtureHome 'custom-plugins'))) 'Check created install directories.'
    Write-Host '[PASS] read-only check'

    $env:DSH_HOME = 'an original process value'
    $env:npm_config_offline = 'false'
    $env:npm_config_ignore_scripts = 'false'
    $installed = Invoke-MediaDeployment -Mode Install @parameters
    Assert-Test ($env:DSH_HOME -eq 'an original process value') 'DSH_HOME process value was not restored.'
    Assert-Test ($env:npm_config_offline -eq 'false' -and $env:npm_config_ignore_scripts -eq 'false') 'npm configuration was not restored after success.'
    $manifest = Read-MediaJson $manifestPath
    Assert-Test ($manifest.dependencies.'other-plugin' -eq 'link:D:/an unrelated place') 'Another dependency changed.'
    Assert-Test ($manifest.customSetting.keep -eq 'unchanged') 'Another setting changed.'
    Assert-Test (@($manifest.dsh.profile.bundles).Count -eq 4) 'The plugin bundle was not appended once.'
    Assert-Test ((Read-MediaJson $hubManifestPath).version -eq '1.0.0') 'The existing hub package was changed.'
    Assert-Test ((Read-MediaJson (Join-Path $installed.NodeLink 'package.json')).version -eq '1.0.0') 'The installed link is unreadable.'
    Assert-Test ($installed.InstallDir.Contains($unicodeName)) 'Unicode path fixture was not used.'
    Write-Host '[PASS] offline install with Unicode/spaces and process environment restoration'

    $manifestBeforeFailure = [IO.File]::ReadAllText($manifestPath)
    $lockBeforeFailure = [IO.File]::ReadAllText((Join-Path $profilePath 'pnpm-lock.yaml'))
    Write-MediaUtf8 (Join-Path $source 'package.json') '{"name":"dsh-media-reader","version":"1.0.1","type":"module","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}'
    $env:MEDIA_TEST_FAIL_MODE = 'exit'
    Assert-Throws { Invoke-MediaDeployment -Mode Install @parameters } 'was rolled back'
    Assert-Test ($env:npm_config_offline -eq 'false' -and $env:npm_config_ignore_scripts -eq 'false') 'npm configuration was not restored after failure.'
    Assert-Test ([IO.File]::ReadAllText($manifestPath) -eq $manifestBeforeFailure) 'Failed upgrade did not restore the exact manifest bytes.'
    Assert-Test ([IO.File]::ReadAllText((Join-Path $profilePath 'pnpm-lock.yaml')) -eq $lockBeforeFailure) 'Failed upgrade did not restore lock bytes.'
    Assert-Test ((Read-MediaJson (Join-Path $installed.NodeLink 'package.json')).version -eq '1.0.0') 'Failed upgrade did not restore the previous plugin/link.'
    Write-Host '[PASS] failed upgrade rollback restores prior plugin, link and metadata'

    $env:MEDIA_TEST_FAIL_MODE = 'unrelated'
    Assert-Throws { Invoke-MediaDeployment -Mode Install @parameters } 'unrelated profile setting changed'
    Assert-Test ([IO.File]::ReadAllText($manifestPath) -eq $manifestBeforeFailure) 'Unrelated mutation rollback was not exact.'
    Assert-Test ((Read-MediaJson (Join-Path $installed.NodeLink 'package.json')).version -eq '1.0.0') 'Unrelated mutation did not restore plugin.'
    Write-Host '[PASS] unrelated profile mutation is refused and rolled back'

    $env:MEDIA_TEST_FAIL_MODE = $null
    $upgraded = Invoke-MediaDeployment -Mode Install @parameters
    Assert-Test ((Read-MediaJson (Join-Path $upgraded.NodeLink 'package.json')).version -eq '1.0.1') 'Upgrade did not install the new release.'
    Assert-Test (@((Read-MediaJson $manifestPath).dsh.profile.bundles | Where-Object { $_ -eq 'dsh-media-reader' }).Count -eq 1) 'Upgrade duplicated the bundle.'
    Write-Host '[PASS] upgrade is idempotent and keeps one bundle'

    $env:MEDIA_TEST_FAIL_MODE = 'reorder'
    $reordered = Invoke-MediaDeployment -Mode Install @parameters
    Assert-Test ((Read-MediaJson $manifestPath).customSetting.nested.alpha -eq 1) 'Nested values changed during key-order-only rewrite.'
    Assert-Test ((Read-MediaJson (Join-Path $reordered.NodeLink 'package.json')).version -eq '1.0.1') 'Key-order-only rewrite was incorrectly refused.'
    Write-Host '[PASS] root and nested object key reorder is accepted'

    $arrayBeforeFailure = [IO.File]::ReadAllText($manifestPath)
    $env:MEDIA_TEST_FAIL_MODE = 'arrayorder'
    Assert-Throws { Invoke-MediaDeployment -Mode Install @parameters } 'unrelated profile setting changed'
    Assert-Test ([IO.File]::ReadAllText($manifestPath) -eq $arrayBeforeFailure) 'Array-order mutation was not rolled back.'
    Write-Host '[PASS] array order remains significant and is protected'
    $env:MEDIA_TEST_FAIL_MODE = $null

    $later = Read-MediaJson $manifestPath
    $later.dependencies | Add-Member -NotePropertyName 'later-plugin' -NotePropertyValue 'link:D:/later'
    $later.dsh.profile.bundles = @($later.dsh.profile.bundles) + 'later-plugin'
    Write-MediaUtf8 $manifestPath ($later | ConvertTo-Json -Depth 50)
    $removed = Invoke-MediaDeployment -Mode Uninstall @parameters
    $remaining = Read-MediaJson $manifestPath
    Assert-Test ($remaining.dependencies.'later-plugin' -eq 'link:D:/later') 'Uninstall erased a later plugin.'
    Assert-Test (@($remaining.dsh.profile.bundles) -contains 'later-plugin') 'Uninstall erased a later bundle.'
    Assert-Test (@($remaining.dsh.profile.bundles) -notcontains 'dsh-media-reader') 'Uninstall left the hub bundle.'
    Assert-Test (-not (Test-Path -LiteralPath $removed.InstallDir)) 'Uninstall left the active stable directory.'
    Write-Host '[PASS] uninstall preserves settings added after installation'

    Assert-Throws { Invoke-MediaDeployment -Mode Install -DshPath $fakeCli -DshHome $fixtureHome -Profile '..\escape' -PluginSource $source } 'profile name'
    Assert-Throws { Remove-MediaOwnedDirectory $fixtureHome $source } 'outside the expected directory'
    Write-Host '[PASS] path traversal and cross-root deletion are refused'

    function Get-MediaDshProcesses { return @([pscustomobject]@{ Id = 12345 }) }
    $beforeRunning = [IO.File]::ReadAllText($manifestPath)
    Assert-Throws { Invoke-MediaDeployment -Mode Install @parameters } 'DSH Desktop is running'
    Assert-Test ([IO.File]::ReadAllText($manifestPath) -eq $beforeRunning) 'Running-app refusal changed metadata.'
    Write-Host '[PASS] running desktop refusal is non-mutating'
    $success = $true
    Write-Host 'Portable installer: 11 meaningful fixture groups passed. No real DSH profile was changed.'
} finally {
    $env:MEDIA_TEST_FAIL_MODE = $savedTestFail
    $env:DSH_HOME = $savedDshHome
    $env:npm_config_offline = $savedOffline
    $env:npm_config_ignore_scripts = $savedIgnoreScripts
    $env:MEDIA_TEST_DSH_VERSION = $savedTestVersion
    if ($success) { Remove-MediaOwnedDirectory $testRoot $testBoundary }
    else { Write-Host ('Fixture retained for diagnosis: ' + $fixture) }
}
