#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Uninstall', 'Check')][string]$Mode = 'Check',
    [string]$DshPath,
    [string]$DshHome,
    [string]$Profile = 'desktop',
    [string]$PluginSource,
    [switch]$Library
)

$ErrorActionPreference = 'Stop'
$script:MediaPackageName = 'dsh-media-reader'
$script:MediaMetadataNames = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml', 'compatibility.json')

function Read-MediaJson([string]$Path) {
    return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json)
}

function Write-MediaUtf8([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Get-MediaAbsolutePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'An empty path is not allowed.' }
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-MediaChildPath([string]$Path, [string]$Root) {
    $fullPath = Get-MediaAbsolutePath $Path
    $fullRoot = Get-MediaAbsolutePath $Root
    $prefix = $fullRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('Refusing a file operation outside the expected directory: ' + $fullPath)
    }
    return $fullPath
}

function Test-MediaReparsePoint([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return ($null -ne $item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0))
}

function Assert-MediaNoLinkedAncestors([string]$Path, [string]$Root) {
    $current = Get-MediaAbsolutePath $Path
    $boundary = Get-MediaAbsolutePath $Root
    if ($current -ne $boundary) { $null = Assert-MediaChildPath $current $boundary }
    while ($true) {
        if (Test-MediaReparsePoint $current) { throw ('A managed directory is a reparse point: ' + $current) }
        if ($current.Equals($boundary, [StringComparison]::OrdinalIgnoreCase)) { break }
        $current = Split-Path -Parent $current
        if (-not $current) { throw 'Cannot verify the managed directory boundary.' }
    }
}

function Assert-MediaTreeNoLinks([string]$Path) {
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Path)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        if (Test-MediaReparsePoint $directory) { throw ('A managed directory is a reparse point: ' + $directory) }
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('A managed directory contains a reparse point: ' + $item.FullName) }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
}

function Remove-MediaOwnedDirectory([string]$Path, [string]$Root) {
    $checked = Assert-MediaChildPath $Path $Root
    if (-not (Test-Path -LiteralPath $checked)) { return }
    Assert-MediaNoLinkedAncestors $checked $Root
    Assert-MediaTreeNoLinks $checked
    Remove-Item -LiteralPath $checked -Recurse -Force
}

function Get-MediaDshProcesses {
    return @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
}

function Get-MediaUserProfile {
    $value = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if ([string]::IsNullOrWhiteSpace($value)) { $value = $env:USERPROFILE }
    if ([string]::IsNullOrWhiteSpace($value)) { throw 'Cannot determine the current Windows user directory.' }
    return Get-MediaAbsolutePath $value
}

function Find-MediaDshCli([string]$RequestedPath) {
    $candidates = New-Object 'System.Collections.Generic.List[string]'
    if ($RequestedPath) {
        $requested = Get-MediaAbsolutePath $RequestedPath
        if (Test-Path -LiteralPath $requested -PathType Container) {
            $requested = Join-Path $requested 'resources\runtime\cli\bin\dsh.cmd'
        }
        if (-not (Test-Path -LiteralPath $requested -PathType Leaf)) { throw ('DSH CLI was not found at: ' + $requested) }
        return $requested
    }
    $userRoot = Get-MediaUserProfile
    $localRoots = @((Join-Path $userRoot 'AppData\Local'), $env:LOCALAPPDATA)
    foreach ($localRoot in $localRoots) {
        if ($localRoot) { $candidates.Add((Join-Path $localRoot 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')) }
    }
    foreach ($programRoot in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($programRoot) { $candidates.Add((Join-Path $programRoot 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')) }
    }
    foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        try {
            foreach ($entry in @(Get-ItemProperty -Path $registryRoot -ErrorAction SilentlyContinue)) {
                if ($entry.DisplayName -like '*DeepSeek Harness*' -and $entry.InstallLocation) {
                    $candidates.Add((Join-Path $entry.InstallLocation 'resources\runtime\cli\bin\dsh.cmd'))
                }
            }
        } catch { }
    }
    foreach ($process in @(Get-MediaDshProcesses)) {
        try {
            if ($process.Path) { $candidates.Add((Join-Path (Split-Path -Parent $process.Path) 'resources\runtime\cli\bin\dsh.cmd')) }
        } catch { }
    }
    $command = Get-Command dsh.cmd -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { $candidates.Add($command.Source) }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return Get-MediaAbsolutePath $candidate }
    }
    throw 'DSH Desktop was not found. Start it once, or run portable.ps1 with -DshPath <DSH installation directory>.'
}

function Get-MediaEnvironment([string]$RequestedDshPath, [string]$RequestedHome, [string]$ProfileName, [string]$Source) {
    if ($ProfileName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or $ProfileName -eq '.' -or $ProfileName -eq '..') {
        throw 'The profile name may contain letters, numbers, dot, underscore and hyphen; path components are not allowed.'
    }
    if (-not [Environment]::Is64BitOperatingSystem -or (@($env:PROCESSOR_ARCHITECTURE, $env:PROCESSOR_ARCHITEW6432) -notcontains 'AMD64')) { throw 'This release supports Windows x64 only (not ARM64 or 32-bit Windows).' }
    $cli = Find-MediaDshCli $RequestedDshPath
    $resolvedHome = $RequestedHome
    if (-not $resolvedHome) { $resolvedHome = $env:DSH_HOME }
    if (-not $resolvedHome) { $resolvedHome = Join-Path (Get-MediaUserProfile) '.dsh' }
    $resolvedHome = Get-MediaAbsolutePath $resolvedHome
    $profileDir = Assert-MediaChildPath (Join-Path $resolvedHome ('profiles\' + $ProfileName)) $resolvedHome
    $manifestPath = Join-Path $profileDir 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw ('The DSH profile is not initialized: ' + $profileDir + '. Open DSH Desktop once before installing.')
    }
    $manifest = Read-MediaJson $manifestPath
    if (-not $manifest.dsh -or -not $manifest.dsh.profile) { throw ('Not a DSH profile: ' + $profileDir) }
    if (-not $Source) {
        $packageRoot = Split-Path -Parent $PSScriptRoot
        if (Test-Path -LiteralPath (Join-Path $packageRoot 'plugin\package.json')) { $Source = Join-Path $packageRoot 'plugin' }
        else { $Source = $packageRoot }
    }
    $Source = Get-MediaAbsolutePath $Source
    $pluginRoot = Assert-MediaChildPath (Join-Path $resolvedHome ('custom-plugins\' + $script:MediaPackageName)) $resolvedHome
    $installDir = Assert-MediaChildPath (Join-Path $pluginRoot $ProfileName) $pluginRoot
    Assert-MediaNoLinkedAncestors $profileDir $resolvedHome
    Assert-MediaNoLinkedAncestors (Join-Path $profileDir 'node_modules') $resolvedHome
    Assert-MediaNoLinkedAncestors $installDir $resolvedHome
    return [pscustomobject]@{ Cli = $cli; Home = $resolvedHome; Profile = $ProfileName; ProfileDir = $profileDir; Manifest = $manifestPath; Source = $Source; PluginRoot = $pluginRoot; InstallDir = $installDir; NodeLink = (Join-Path $profileDir ('node_modules\' + $script:MediaPackageName)) }
}

function Invoke-MediaCli($Environment, [string[]]$Arguments) {
    $processValues = @{
        DSH_HOME = $Environment.Home
        npm_config_offline = 'true'
        npm_config_ignore_scripts = 'true'
    }
    $previousValues = @{}
    foreach ($key in $processValues.Keys) { $previousValues[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
    try {
        # DSH may run a compatibility-repair pnpm subprocess without forwarding
        # the original command-line flags. Config environment reaches it too.
        foreach ($key in $processValues.Keys) { [Environment]::SetEnvironmentVariable($key, $processValues[$key], 'Process') }
        $global:LASTEXITCODE = 0
        & $Environment.Cli @Arguments | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { throw ('DSH CLI failed with exit code ' + $LASTEXITCODE + '.') }
    } finally {
        foreach ($key in $processValues.Keys) { [Environment]::SetEnvironmentVariable($key, $previousValues[$key], 'Process') }
    }
}

function ConvertTo-MediaCanonicalValue($Value) {
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]) { return $Value }
    if ($Value -is [Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object)) { $ordered[$key] = ConvertTo-MediaCanonicalValue $Value[$key] }
        return [pscustomobject]$ordered
    }
    if ($Value -is [Collections.IEnumerable]) {
        $items = New-Object 'System.Collections.Generic.List[object]'
        foreach ($item in $Value) { $items.Add((ConvertTo-MediaCanonicalValue $item)) }
        return ,($items.ToArray())
    }
    $ordered = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Sort-Object Name)) {
        $ordered[$property.Name] = ConvertTo-MediaCanonicalValue $property.Value
    }
    return [pscustomobject]$ordered
}

function Get-MediaOtherManifestState($Manifest) {
    $copy = ($Manifest | ConvertTo-Json -Depth 100 | ConvertFrom-Json)
    if ($copy.dependencies) { $copy.dependencies.PSObject.Properties.Remove($script:MediaPackageName) }
    if ($copy.dsh -and $copy.dsh.profile) {
        $copy.dsh.profile.bundles = @($copy.dsh.profile.bundles | Where-Object { $_ -ne $script:MediaPackageName })
    }
    # pnpm may add/update its own packageManager annotation.
    $copy.PSObject.Properties.Remove('packageManager')
    if ($copy.dependencies -and @($copy.dependencies.PSObject.Properties).Count -eq 0) { $copy.PSObject.Properties.Remove('dependencies') }
    # Object key order is not semantic; array order remains significant.
    return ((ConvertTo-MediaCanonicalValue $copy) | ConvertTo-Json -Depth 100 -Compress)
}

function New-MediaBackup($Environment) {
    $backupRoot = Assert-MediaChildPath (Join-Path $Environment.Home ('backups\' + $script:MediaPackageName)) $Environment.Home
    Assert-MediaNoLinkedAncestors $backupRoot $Environment.Home
    $backup = Assert-MediaChildPath (Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))) $backupRoot
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $files = @()
    foreach ($name in $script:MediaMetadataNames) {
        $path = Join-Path $Environment.ProfileDir $name
        $exists = Test-Path -LiteralPath $path -PathType Leaf
        $files += [pscustomobject]@{ Name = $name; Existed = $exists }
        if ($exists) { Copy-Item -LiteralPath $path -Destination (Join-Path $backup $name) }
    }
    $oldLink = Get-Item -LiteralPath $Environment.NodeLink -Force -ErrorAction SilentlyContinue
    $link = $null
    if ($oldLink) {
        if (($oldLink.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $target = @($oldLink.Target)[0]
            if (-not $target) { throw ('Cannot back up the existing plugin link: ' + $Environment.NodeLink) }
            if (-not [IO.Path]::IsPathRooted($target)) { $target = Get-MediaAbsolutePath (Join-Path $oldLink.Parent.FullName $target) }
            $link = [pscustomobject]@{ Kind = 'Link'; Target = $target; Type = $oldLink.LinkType }
        } else {
            Assert-MediaTreeNoLinks $oldLink.FullName
            Copy-Item -LiteralPath $oldLink.FullName -Destination (Join-Path $backup 'node-module-previous') -Recurse
            $link = [pscustomobject]@{ Kind = 'Directory' }
        }
    }
    $record = [pscustomobject]@{ Profile = $Environment.Profile; CreatedAt = (Get-Date).ToString('o'); InstallDir = $Environment.InstallDir; Files = $files; Link = $link }
    Write-MediaUtf8 (Join-Path $backup 'transaction.json') (($record | ConvertTo-Json -Depth 20) + [Environment]::NewLine)
    return [pscustomobject]@{ Directory = $backup; Record = $record; PreviousPluginMoved = $false; NewPluginCopied = $false }
}

function Remove-MediaNodeLink($Environment) {
    $checked = Assert-MediaChildPath $Environment.NodeLink (Join-Path $Environment.ProfileDir 'node_modules')
    $entry = Get-Item -LiteralPath $checked -Force -ErrorAction SilentlyContinue
    if (-not $entry) { return }
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        # Delete only the junction/symlink entry; never recurse into its target.
        [IO.Directory]::Delete($checked, $false)
    } else { Remove-MediaOwnedDirectory $checked (Join-Path $Environment.ProfileDir 'node_modules') }
}

function Restore-MediaBackup($Environment, $Backup) {
    foreach ($file in $Backup.Record.Files) {
        $target = Join-Path $Environment.ProfileDir $file.Name
        if ($file.Existed) { Copy-Item -LiteralPath (Join-Path $Backup.Directory $file.Name) -Destination $target -Force }
        elseif (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
    }
    if ($Backup.NewPluginCopied -and (Test-Path -LiteralPath $Environment.InstallDir)) {
        Remove-MediaOwnedDirectory $Environment.InstallDir $Environment.PluginRoot
    }
    if ($Backup.PreviousPluginMoved) {
        $source = Assert-MediaChildPath (Join-Path $Backup.Directory 'plugin-previous') $Backup.Directory
        $target = Assert-MediaChildPath $Environment.InstallDir $Environment.PluginRoot
        Move-Item -LiteralPath $source -Destination $target
    }
    Remove-MediaNodeLink $Environment
    if ($Backup.Record.Link) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $Environment.NodeLink) -Force | Out-Null
        if ($Backup.Record.Link.Kind -eq 'Link') {
            $kind = if ($Backup.Record.Link.Type -eq 'SymbolicLink') { 'SymbolicLink' } else { 'Junction' }
            New-Item -ItemType $kind -Path $Environment.NodeLink -Target $Backup.Record.Link.Target | Out-Null
        } else {
            Copy-Item -LiteralPath (Join-Path $Backup.Directory 'node-module-previous') -Destination $Environment.NodeLink -Recurse
        }
    }
}

function Assert-MediaPluginSource($Environment) {
    $required = @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js', 'lib\media.js',
        'vendor\ffmpeg\bin\ffmpeg.exe', 'vendor\ffmpeg\bin\ffprobe.exe',
        'vendor\ffmpeg\bin\avcodec-62.dll', 'vendor\ffmpeg\bin\avdevice-62.dll', 'vendor\ffmpeg\bin\avfilter-11.dll',
        'vendor\ffmpeg\bin\avformat-62.dll', 'vendor\ffmpeg\bin\avutil-60.dll',
        'vendor\ffmpeg\bin\swresample-6.dll', 'vendor\ffmpeg\bin\swscale-9.dll',
        'vendor\ffmpeg\LICENSE.txt', 'vendor\ffmpeg\source\ffmpeg-source.tar.gz', 'vendor\ffmpeg\source\ffmpeg-build-scripts.tar.gz')
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Environment.Source $relative) -PathType Leaf)) { throw ('The plugin package is incomplete: missing ' + $relative) }
    }
    $self = Read-MediaJson (Join-Path $Environment.Source 'package.json')
    if ($self.name -ne $script:MediaPackageName) { throw 'The source package name is not dsh-media-reader.' }
    if ($self.dependencies -and @($self.dependencies.PSObject.Properties).Count -gt 0) { throw 'This portable installer expects a prebuilt plugin with no external runtime dependencies.' }
    $installPrefix = $Environment.InstallDir + [IO.Path]::DirectorySeparatorChar
    $sourcePrefix = $Environment.Source + [IO.Path]::DirectorySeparatorChar
    if ($Environment.Source.Equals($Environment.InstallDir, [StringComparison]::OrdinalIgnoreCase) -or $Environment.Source.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase) -or $Environment.InstallDir.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The release source and target installation must be separate directories.'
    }
    if (Test-MediaReparsePoint $Environment.Source) { throw 'The release source must be an ordinary directory, not a reparse point.' }
    Assert-MediaTreeNoLinks $Environment.Source
    return $self
}

function Assert-MediaHostVersion($Environment) {
    $global:LASTEXITCODE = 0
    $versionOutput = (& $Environment.Cli --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch '(?m)^0\.2\.1-rc\.2\s*$') {
        throw ('This release requires DSH 0.2.1-rc.2. Detected CLI output: ' + $versionOutput)
    }
    Write-Host 'DSH version: 0.2.1-rc.2'
}

function Assert-MediaHubDependency($Environment, $Manifest) {
    $hubName = 'dsh-plugin-hub'
    if (-not $Manifest.dependencies -or -not $Manifest.dependencies.PSObject.Properties[$hubName] -or @($Manifest.dsh.profile.bundles) -notcontains $hubName) {
        throw 'Required dsh-plugin-hub is missing. Unzip dependencies\dsh-plugin-hub-1.0.0-win-x64.zip, run its installer first, then run this installer again. Existing hub settings are not changed.'
    }
    $hubManifestPath = Join-Path $Environment.ProfileDir ('node_modules\' + $hubName + '\package.json')
    if (-not (Test-Path -LiteralPath $hubManifestPath -PathType Leaf)) { throw 'dsh-plugin-hub is registered but its installed package cannot be read. Repair the hub installation first.' }
    $hub = Read-MediaJson $hubManifestPath
    if ($hub.name -ne $hubName -or $hub.version -ne '1.0.0') { throw ('This release requires dsh-plugin-hub 1.0.0. Found: ' + $hub.version + '. No hub downgrade or replacement was attempted.') }
    Write-Host 'Extension pocket dependency: dsh-plugin-hub 1.0.0 ready'
}

function Invoke-MediaDeployment {
    [CmdletBinding()]
    param([ValidateSet('Install', 'Uninstall', 'Check')][string]$Mode = 'Check', [string]$DshPath, [string]$DshHome, [string]$Profile = 'desktop', [string]$PluginSource)
    $environment = Get-MediaEnvironment $DshPath $DshHome $Profile $PluginSource
    Write-Host ('DSH CLI: ' + $environment.Cli)
    Write-Host ('DSH home: ' + $environment.Home)
    Write-Host ('Profile: ' + $environment.Profile)
    Write-Host ('Stable plugin directory: ' + $environment.InstallDir)
    $manifest = Read-MediaJson $environment.Manifest
    if ($Mode -ne 'Uninstall') { Assert-MediaHostVersion $environment }
    if ($Mode -ne 'Uninstall') { Assert-MediaHubDependency $environment $manifest }
    $installed = ($manifest.dependencies -and $manifest.dependencies.PSObject.Properties[$script:MediaPackageName]) -or (@($manifest.dsh.profile.bundles) -contains $script:MediaPackageName)
    $running = @(Get-MediaDshProcesses)
    if ($Mode -eq 'Check') {
        $self = Assert-MediaPluginSource $environment
        Write-Host ('Release: ' + $self.name + ' ' + $self.version)
        Write-Host ('Currently registered: ' + [bool]$installed)
        Write-Host ('DSH Desktop processes: ' + $running.Count)
        if ($running.Count) { Write-Host 'Close DSH completely before installation or removal.' }
        Write-Host 'Check complete. No files or settings were changed.'
        return $environment
    }
    if ($running.Count -gt 0) { throw 'DSH Desktop is running. Completely exit it, including the tray icon, and run this action again.' }
    if ($Mode -eq 'Uninstall' -and -not $installed) {
        Write-Host 'The plugin is not registered in this profile. No changes were made.'
        return $environment
    }
    if ($Mode -eq 'Install') { $self = Assert-MediaPluginSource $environment }
    if (Test-MediaReparsePoint $environment.PluginRoot) { throw 'The plugin installation root is a reparse point; choose an ordinary DSH home directory.' }
    if (Test-MediaReparsePoint $environment.InstallDir) { throw 'The plugin installation directory is a reparse point; remove it before installing.' }
    $otherBefore = Get-MediaOtherManifestState $manifest
    $backup = New-MediaBackup $environment
    Write-Host ('Transaction backup: ' + $backup.Directory)
    try {
        if ($Mode -eq 'Install') {
            New-Item -ItemType Directory -Path $environment.PluginRoot -Force | Out-Null
            if (Test-Path -LiteralPath $environment.InstallDir) {
                $old = Assert-MediaChildPath $environment.InstallDir $environment.PluginRoot
                $backupTarget = Assert-MediaChildPath (Join-Path $backup.Directory 'plugin-previous') $backup.Directory
                Move-Item -LiteralPath $old -Destination $backupTarget
                $backup.PreviousPluginMoved = $true
            }
            $backup.NewPluginCopied = $true
            Copy-Item -LiteralPath $environment.Source -Destination $environment.InstallDir -Recurse
            $spec = 'link:' + $environment.InstallDir.Replace('\', '/')
            Invoke-MediaCli $environment @('plugin', '--profile', $environment.Profile, 'add', $spec, '--offline', '--ignore-scripts')
            $after = Read-MediaJson $environment.Manifest
            if (-not $after.dependencies -or -not $after.dependencies.PSObject.Properties[$script:MediaPackageName] -or @($after.dsh.profile.bundles) -notcontains $script:MediaPackageName) {
                throw 'DSH did not register both the plugin dependency and bundle.'
            }
            $registered = Read-MediaJson (Join-Path $environment.NodeLink 'package.json')
            if ($registered.name -ne $script:MediaPackageName -or $registered.version -ne $self.version) { throw 'The installed package could not be verified through the profile link.' }
        } else {
            Invoke-MediaCli $environment @('plugin', '--profile', $environment.Profile, 'remove', $script:MediaPackageName, '--offline', '--ignore-scripts')
            $after = Read-MediaJson $environment.Manifest
            if (($after.dependencies -and $after.dependencies.PSObject.Properties[$script:MediaPackageName]) -or @($after.dsh.profile.bundles) -contains $script:MediaPackageName) { throw 'DSH did not remove the plugin registration.' }
        }
        if ((Get-MediaOtherManifestState $after) -ne $otherBefore) { throw 'An unrelated profile setting changed during installation; rolling back this transaction.' }
        $patchBefore = Join-Path $backup.Directory 'cordis.patch.yml'
        $patchNow = Join-Path $environment.ProfileDir 'cordis.patch.yml'
        if ((Test-Path -LiteralPath $patchBefore) -and ([IO.File]::ReadAllText($patchBefore) -ne [IO.File]::ReadAllText($patchNow))) { throw 'The user patch unexpectedly changed; rolling back this transaction.' }
        if ($Mode -eq 'Uninstall' -and (Test-Path -LiteralPath $environment.InstallDir)) {
            $old = Assert-MediaChildPath $environment.InstallDir $environment.PluginRoot
            $backupTarget = Assert-MediaChildPath (Join-Path $backup.Directory 'plugin-previous') $backup.Directory
            Move-Item -LiteralPath $old -Destination $backupTarget
            $backup.PreviousPluginMoved = $true
        }
        Write-MediaUtf8 (Join-Path $backup.Directory 'result.txt') ($Mode + ' succeeded. This backup is retained for recovery.' + [Environment]::NewLine)
        Write-Host ($Mode + ' complete. Start DSH Desktop again.')
        return $environment
    } catch {
        $failure = $_
        try {
            Restore-MediaBackup $environment $backup
            Write-Host 'The failed transaction was rolled back. Other plugin settings were preserved.'
        } catch {
            throw ('Deployment failed: ' + $failure.Exception.Message + ' Automatic rollback also failed: ' + $_.Exception.Message + ' Backup: ' + $backup.Directory)
        }
        throw ('Deployment failed and was rolled back: ' + $failure.Exception.Message + ' No online fallback was attempted. Backup: ' + $backup.Directory)
    }
}

if (-not $Library) {
    try {
        Invoke-MediaDeployment -Mode $Mode -DshPath $DshPath -DshHome $DshHome -Profile $Profile -PluginSource $PluginSource | Out-Null
    } catch {
        Write-Host ('[ERROR] ' + $_.Exception.Message) -ForegroundColor Red
        exit 1
    }
}
