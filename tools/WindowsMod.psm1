Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:RepoRoot = Split-Path $PSScriptRoot -Parent
$script:ConfigPath = 'ProjectPBZ/Content/JidonPBZ.json'
$script:ModPaths = @('platform/steam/hid.dll', 'ProjectPBZ/Content/JavaScript/JidonPBZ/boot.js')

function Get-BytesHash([byte[]]$Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}
function Get-SafePath([string]$Root, [string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative -match '(^[\\/]|:|(^|[\\/])\.\.([\\/]|$))') { throw 'Unsafe relative path.' }
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\','/')
    $path = [IO.Path]::GetFullPath([IO.Path]::Combine($base, $Relative.Replace('/', '\')))
    if (!$path.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escapes destination.' }
    $cursor = $path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Links/junctions are not supported: $cursor" }
        }
        $cursor = Split-Path $cursor -Parent
    }
    return $path
}
function Read-JsonFile([string]$Path) {
    $utf8 = New-Object Text.UTF8Encoding($false, $true)
    return ([IO.File]::ReadAllText($Path, $utf8) | ConvertFrom-Json)
}
function Write-AtomicBytes([string]$Path, [byte[]]$Bytes) {
    $dir = Split-Path $Path -Parent
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    $temp = Join-Path $dir ('.pbz-sync-' + [Guid]::NewGuid().ToString('N'))
    $swapBackup = $temp + '.previous'
    try {
        $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temp, $Path, $swapBackup) }
        else { [IO.File]::Move($temp, $Path) }
    } finally {
        if (Test-Path -LiteralPath $temp) { [IO.File]::Delete($temp) }
        if (Test-Path -LiteralPath $swapBackup) { [IO.File]::Delete($swapBackup) }
    }
}
function Write-JsonFile([string]$Path, $Value) {
    $utf8 = New-Object Text.UTF8Encoding($false)
    Write-AtomicBytes $Path $utf8.GetBytes(($Value | ConvertTo-Json -Depth 12) + "`n")
}
function Assert-Settings([string]$Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-Item -LiteralPath $Path).Length -gt 65536) { throw 'Settings file is missing or too large.' }
    $config = Read-JsonFile $Path
    foreach ($key in @('enabled','blue','red','selfTest')) {
        if ($config.$key -isnot [bool]) { throw "Invalid setting: $key" }
    }
    foreach ($spec in @(@('deflect',1,3),@('dodge',1,3),@('speed',0.25,1),@('seconds',0.2,2))) {
        $value = $config.($spec[0])
        $numeric = $value -is [int] -or $value -is [long] -or $value -is [double] -or $value -is [decimal]
        if (!$numeric -or [double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value) -or $value -lt $spec[1] -or $value -gt $spec[2]) { throw "Invalid setting: $($spec[0])" }
    }
}
function Get-PbzProcesses { return @(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -like 'PBZ*' }) }
function Assert-GameClosed { if (@(Get-PbzProcesses).Count) { throw 'Close Phantom Blade Zero before changing files.' } }
function Assert-GameFolder([string]$Game) {
    $exe = Get-SafePath $Game 'platform/steam/PBZ.exe'
    if (!(Test-Path -LiteralPath $exe -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $Game 'ProjectPBZ') -PathType Container)) { throw 'Select the PBZ folder containing ProjectPBZ and platform/steam/PBZ.exe.' }
}
function Assert-GameBuild([string]$Game) {
    $profile = Read-JsonFile (Join-Path $script:RepoRoot 'native/game-build.json')
    $actual = (Get-FileHash -LiteralPath (Get-SafePath $Game 'platform/steam/PBZ.exe') -Algorithm SHA256).Hash
    if ($actual -ne $profile.sha256) { throw 'Unsupported game version. No game files changed. This bundle supports Steam build 26367565 / game 302256-17280.' }
}
function Get-Bundle {
    $lock = Read-JsonFile (Join-Path $script:RepoRoot 'bundle.lock.json')
    $data = @{}
    $sources = @{'platform/steam/hid.dll'='dist/hid.dll';'ProjectPBZ/Content/JavaScript/JidonPBZ/boot.js'='scripts/boot.js'}
    foreach ($package in $lock.packages) { foreach ($entry in $package.files) {
        if (!$sources.ContainsKey($entry.path) -or $entry.source -ne $sources[$entry.path] -or $data.ContainsKey($entry.path)) { throw 'Unexpected bundle entry.' }
        $file = Get-SafePath $script:RepoRoot $entry.source
        if ((Get-Item -LiteralPath $file).Length -gt 2097152) { throw 'Unexpected bundle size.' }
        $bytes = [IO.File]::ReadAllBytes($file)
        if ($entry.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-BytesHash $bytes) -ne $entry.sha256) { throw "Bundle integrity check failed: $($entry.source)" }
        $data[$entry.path] = $bytes
    } }
    if ($data.Count -ne 2) { throw 'Incomplete bundle. Extract the entire GitHub ZIP first.' }
    return @{Lock=$lock;Data=$data}
}
function Test-Pair([string]$Game, $Files) {
    $names = @($Files.PSObject.Properties.Name)
    if ($names.Count -ne 2 -or @(Compare-Object $script:ModPaths $names).Count) { return $false }
    foreach ($rel in $names) {
        $path = Get-SafePath $Game $rel
        if (!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $Files.$rel) { return $false }
    }
    return $true
}
function Get-InstalledKind([string]$Game, $Bundle) {
    $current = [ordered]@{}
    foreach ($rel in $script:ModPaths) { $current[$rel] = Get-BytesHash $Bundle.Data[$rel] }
    if (Test-Pair $Game ([pscustomobject]$current)) { return 'current' }
    foreach ($previous in $Bundle.Lock.previous_bundles) { if (Test-Pair $Game $previous.files) { return 'previous' } }
    foreach ($rel in $script:ModPaths) { if (Test-Path -LiteralPath (Get-SafePath $Game $rel)) { return 'unknown' } }
    return 'absent'
}
function Assert-NoLegacyMod([string]$Game) {
    $paths = @('ProjectPBZ/Content/JavaScript/PBZModsMenu') + @('pak','utoc','ucas' | ForEach-Object { 'ProjectPBZ/Content/Paks/~mods/zzz_PBZPerfectDefense_P.' + $_ })
    foreach ($rel in $paths) { if (Test-Path -LiteralPath (Get-SafePath $Game $rel)) { throw "Existing third-party mod detected; no files changed: $rel" } }
}
function Read-SteamLibraryPaths([string]$File) {
    if (!(Test-Path -LiteralPath $File)) { return @() }
    $text = [IO.File]::ReadAllText($File)
    $found = @()
    foreach ($match in [regex]::Matches($text, '"(?:path|\d+)"\s+"((?:[A-Za-z]:|\\\\)[^"\r\n]*)"')) {
        $found += $match.Groups[1].Value.Replace('\\','\')
    }
    return $found
}
function Find-PBZGame {
    $roots = @()
    foreach ($key in @('HKCU:\Software\Valve\Steam','HKLM:\SOFTWARE\WOW6432Node\Valve\Steam','HKLM:\SOFTWARE\Valve\Steam')) {
        if (Test-Path -LiteralPath $key) {
            $item = Get-ItemProperty -LiteralPath $key
            foreach ($field in @('SteamPath','InstallPath')) { if ($item.PSObject.Properties[$field]) { $roots += [string]$item.$field } }
        }
    }
    if (${env:ProgramFiles(x86)}) { $roots += Join-Path ${env:ProgramFiles(x86)} 'Steam' }
    $libraries = @($roots)
    foreach ($root in $roots) { $libraries += Read-SteamLibraryPaths (Join-Path $root 'steamapps/libraryfolders.vdf') }
    $games = @()
    foreach ($library in @($libraries | Sort-Object -Unique)) {
        if ([string]::IsNullOrWhiteSpace($library)) { continue }
        $apps = Join-Path $library 'steamapps'
        $manifest = Join-Path $apps 'appmanifest_4115450.acf'
        if (!(Test-Path -LiteralPath $manifest)) { continue }
        $match = [regex]::Match([IO.File]::ReadAllText($manifest), '"installdir"\s+"([^"\r\n]+)"')
        if (!$match.Success) { continue }
        try { $game = Get-SafePath (Join-Path $apps 'common') $match.Groups[1].Value; Assert-GameFolder $game; $games += $game } catch { continue }
    }
    return @($games | Sort-Object -Unique)
}
function Invoke-Changes([string]$TargetRoot, [string]$Game, [hashtable]$Payload, [string[]]$Remove, [string]$Action, [bool]$Apply) {
    $plan = @()
    foreach ($rel in @(@($Payload.Keys) + @($Remove) | Sort-Object -Unique)) {
        $path = Get-SafePath $TargetRoot $rel
        $old = $null; if (Test-Path -LiteralPath $path) { $old = [IO.File]::ReadAllBytes($path) }
        $new = $null; if ($Payload.ContainsKey($rel)) { $new = $Payload[$rel] }
        $before = $null; if ($null -ne $old) { $before = Get-BytesHash $old }
        $after = $null; if ($null -ne $new) { $after = Get-BytesHash $new }
        if ($before -ne $after) { $plan += [pscustomobject]@{Path=$rel;Old=$old;New=$new;Before=$before;After=$after} }
    }
    $summary = [ordered]@{Action=$Action;Game=$Game;Apply=$Apply;Changes=@($plan | ForEach-Object { $_.Path });Receipt=$null}
    if (!$Apply -or !$plan.Count) { return [pscustomobject]$summary }
    Assert-GameClosed
    $run = Get-SafePath $script:RepoRoot ('.local/windows-backups/' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
    [IO.Directory]::CreateDirectory($run) | Out-Null
    $receipt = [ordered]@{Version=1;Action=$Action;Game=$Game;TargetRoot=$TargetRoot;Status='prepared';Files=@()}
    foreach ($entry in $plan) {
        if ($null -ne $entry.Old) { Write-AtomicBytes (Get-SafePath $run ('original/' + $entry.Path)) $entry.Old }
        $receipt.Files += [ordered]@{Path=$entry.Path;Before=$entry.Before;After=$entry.After}
    }
    $record = Join-Path $run 'receipt.json'
    Write-JsonFile $record $receipt
    $written = @()
    try {
        foreach ($entry in $plan) {
            Assert-GameClosed
            $target = Get-SafePath $TargetRoot $entry.Path
            $current = $null; if (Test-Path -LiteralPath $target) { $current = Get-BytesHash ([IO.File]::ReadAllBytes($target)) }
            if ($current -ne $entry.Before) { throw "File changed since preview: $($entry.Path)" }
            if ($null -eq $entry.New) { [IO.File]::Delete($target) } else { Write-AtomicBytes $target $entry.New }
            $written += $entry
            $actual = $null; if (Test-Path -LiteralPath $target) { $actual = Get-BytesHash ([IO.File]::ReadAllBytes($target)) }
            if ($actual -ne $entry.After) { throw 'Write verification failed.' }
        }
        $receipt.Status = 'applied-file-verified'; Write-JsonFile $record $receipt
    } catch {
        $failure = $_
        [array]::Reverse($written)
        foreach ($entry in $written) {
            try {
                $target = Get-SafePath $TargetRoot $entry.Path
                $actual = $null; if (Test-Path -LiteralPath $target) { $actual = Get-BytesHash ([IO.File]::ReadAllBytes($target)) }
                if ($actual -ne $entry.After) { continue }
                if ($null -eq $entry.Old) { [IO.File]::Delete($target) } else { Write-AtomicBytes $target $entry.Old }
            } catch { Write-Warning "Rollback could not restore $($entry.Path). Backup: $record" }
        }
        $receipt.Status = 'failed-rollback-attempted'; Write-JsonFile $record $receipt
        throw $failure
    }
    $summary.Receipt = $record
    return [pscustomobject]$summary
}
function Invoke-PBZMod {
    [CmdletBinding()]
    param([ValidateSet('Install','Verify','Import','Export','Remove','Restore')][string]$Action, [Parameter(Mandatory)][string]$GamePath, [switch]$Apply, [string]$Receipt)
    $game = [IO.Path]::GetFullPath($GamePath).TrimEnd('\','/')
    Assert-GameFolder $game
    if ($Action -eq 'Restore') {
        $base = Join-Path $script:RepoRoot '.local/windows-backups'
        $receiptPath = [IO.Path]::GetFullPath($Receipt)
        if (!$receiptPath.StartsWith([IO.Path]::GetFullPath($base) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Receipt must belong to this extracted folder.' }
        $r = Read-JsonFile $receiptPath
        if ($r.Version -ne 1 -or $r.Game -ne $game -or $r.TargetRoot -notin @($game,$script:RepoRoot)) { throw 'Receipt target does not match.' }
        $allowed = @($script:ModPaths) + @($script:ConfigPath)
        if ($r.TargetRoot -eq $script:RepoRoot) { $allowed = @('settings/JidonPBZ.json') }
        $payload = @{}; $remove = @(); $seen = @{}
        foreach ($entry in $r.Files) {
            if ($entry.Path -notin $allowed -or $seen.ContainsKey($entry.Path)) { throw 'Unexpected restore path.' }; $seen[$entry.Path] = $true
            $target = Get-SafePath $r.TargetRoot $entry.Path
            $actual = $null; if (Test-Path -LiteralPath $target) { $actual = Get-BytesHash ([IO.File]::ReadAllBytes($target)) }
            if ($actual -ne $entry.After) { throw 'File changed after this operation; refusing to overwrite newer work.' }
            if ($null -eq $entry.Before) { $remove += $entry.Path }
            else {
                $old = [IO.File]::ReadAllBytes((Get-SafePath (Split-Path $receiptPath -Parent) ('original/' + $entry.Path)))
                if ((Get-BytesHash $old) -ne $entry.Before) { throw 'Backup integrity check failed.' }
                $payload[$entry.Path] = $old
            }
        }
        return Invoke-Changes $r.TargetRoot $game $payload $remove $Action $Apply.IsPresent
    }
    $bundle = Get-Bundle
    $kind = Get-InstalledKind $game $bundle
    if ($kind -eq 'unknown') { throw 'Unknown or partial loader/script found. No files changed; isolate that mod before installing.' }
    if ($Action -eq 'Remove') {
        if ($kind -eq 'absent') { return [pscustomobject]@{Action=$Action;Game=$game;Apply=$Apply.IsPresent;Changes=@();Receipt=$null} }
        return Invoke-Changes $game $game @{} $script:ModPaths $Action $Apply.IsPresent
    }
    Assert-GameBuild $game; Assert-NoLegacyMod $game
    $config = Get-SafePath $game $script:ConfigPath
    if ($Action -eq 'Install') {
        $payload = $bundle.Data
        if (Test-Path -LiteralPath $config) { Assert-Settings $config }
        else { $source=Get-SafePath $script:RepoRoot 'settings/JidonPBZ.json';Assert-Settings $source;$payload[$script:ConfigPath]=[IO.File]::ReadAllBytes($source) }
        return Invoke-Changes $game $game $payload @() $Action $Apply.IsPresent
    }
    if ($kind -ne 'current') { throw 'Install/update this bundle first.' }
    if ($Action -eq 'Verify') { Assert-Settings $config;return [pscustomobject]@{Action=$Action;Game=$game;Files='MATCH';Settings='VALID';Values=(Read-JsonFile $config)} }
    if ($Action -eq 'Import') {
        $source = Get-SafePath $script:RepoRoot 'settings/JidonPBZ.json'; Assert-Settings $source
        return Invoke-Changes $game $game @{$script:ConfigPath=[IO.File]::ReadAllBytes($source)} @() $Action $Apply.IsPresent
    }
    Assert-Settings $config
    return Invoke-Changes $script:RepoRoot $game @{'settings/JidonPBZ.json'=[IO.File]::ReadAllBytes($config)} @() $Action $Apply.IsPresent
}
Export-ModuleMember -Function Find-PBZGame, Invoke-PBZMod
