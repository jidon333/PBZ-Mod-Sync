#requires -Version 5.1
$ErrorActionPreference='Stop'
$source=Split-Path $PSScriptRoot -Parent
$scratch=Join-Path ([IO.Path]::GetTempPath()) ('pbz-portable-tests-' + [Guid]::NewGuid().ToString('N'))
$copy=Join-Path $scratch ('Downloaded [' + [char]0xD55C + [char]0xAE00 + '] bundle')
$game=Join-Path $scratch 'Steam library [test]/steamapps/common/PBZ'
$utf8=New-Object Text.UTF8Encoding($false)
function Assert($Condition,[string]$Message) { if (!$Condition) { throw $Message } }
function Expect-Error([scriptblock]$Code,[string]$Pattern) {
    $failed=$false
    try { & $Code | Out-Null } catch { $failed=$true;Assert ($_.Exception.Message -match $Pattern) ("Unexpected error: " + $_.Exception.Message) }
    Assert $failed ('Expected rejection: ' + $Pattern)
}
function Save-Json([string]$Path,$Value) { [IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 12),$utf8) }
$count=0
function Check([string]$Name,[scriptblock]$Code) { & $Code; $script:count++;Write-Output "PASS $Name" }
try {
    foreach ($rel in @('bundle.lock.json','dist/hid.dll','scripts/boot.js','settings/JidonPBZ.json','native/game-build.json','tools/WindowsMod.psm1','tools/windows_mod_manager.ps1','PBZ-Mod-Manager.cmd')) {
        $dest=Join-Path $copy $rel;[IO.Directory]::CreateDirectory((Split-Path $dest -Parent))|Out-Null
        [IO.File]::Copy((Join-Path $source $rel),$dest)
    }
    [IO.Directory]::CreateDirectory((Join-Path $game 'platform/steam'))|Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $game 'ProjectPBZ/Content'))|Out-Null
    $exe=Join-Path $game 'platform/steam/PBZ.exe';[IO.File]::WriteAllText($exe,'fixture, never executed',$utf8)
    $profilePath=Join-Path $copy 'native/game-build.json'
    Save-Json $profilePath @{sha256=(Get-FileHash -LiteralPath $exe).Hash}
    $module=Import-Module (Join-Path $copy 'tools/WindowsMod.psm1') -Force -PassThru
    # Fixture file operations must not depend on an unrelated real game session.
    & $module { function script:Get-PbzProcesses { return @() } }
    $dll=Join-Path $game 'platform/steam/hid.dll'
    $js=Join-Path $game 'ProjectPBZ/Content/JavaScript/JidonPBZ/boot.js'
    $config=Join-Path $game 'ProjectPBZ/Content/JidonPBZ.json'
    $settings=Join-Path $copy 'settings/JidonPBZ.json'
    $originalSettings=[IO.File]::ReadAllBytes($settings)
    Check 'fresh extracted package previews without writing, then installs exact bytes' {
        $preview=Invoke-PBZMod Install -GamePath $game
        Assert ($preview.Changes.Count -eq 3 -and !(Test-Path -LiteralPath $dll)) 'Preview mutated game'
        $script:first=Invoke-PBZMod Install -GamePath $game -Apply
        Assert ($first.Changes.Count -eq 3 -and (Test-Path -LiteralPath $first.Receipt)) 'Missing receipt'
        Assert ((Get-FileHash -LiteralPath $dll).Hash -eq (Get-FileHash -LiteralPath (Join-Path $copy 'dist/hid.dll')).Hash) 'DLL copy differs'
        Assert ((Invoke-PBZMod Verify -GamePath $game).Settings -eq 'VALID') 'Verify failed'
    }
    Check 'reinstall preserves changed personal settings' {
        $cfg=Get-Content -LiteralPath $config -Raw | ConvertFrom-Json;$cfg.deflect=1.5;Save-Json $config $cfg
        Assert ((Invoke-PBZMod Install -GamePath $game -Apply).Changes.Count -eq 0) 'Reinstall changed files'
        Assert ((Get-Content -LiteralPath $config -Raw|ConvertFrom-Json).deflect -eq 1.5) 'Personal setting lost'
        Expect-Error { Invoke-PBZMod Restore -GamePath $game -Receipt $first.Receipt -Apply } 'newer work'
    }
    Check 'export and import back up settings and restore exact previous content' {
        $export=Invoke-PBZMod Export -GamePath $game -Apply
        Assert ((Get-Content -LiteralPath $settings -Raw|ConvertFrom-Json).deflect -eq 1.5) 'Export failed'
        Invoke-PBZMod Restore -GamePath $game -Receipt $export.Receipt -Apply|Out-Null
        $import=Invoke-PBZMod Import -GamePath $game -Apply
        Assert ((Get-Content -LiteralPath $config -Raw|ConvertFrom-Json).deflect -eq 2) 'Import failed'
        Invoke-PBZMod Restore -GamePath $game -Receipt $import.Receipt -Apply|Out-Null
        Assert ((Get-Content -LiteralPath $config -Raw|ConvertFrom-Json).deflect -eq 1.5) 'Restore failed'
    }
    Check 'remove and restore own loader leave settings and game intact' {
        $oldConfig=(Get-FileHash -LiteralPath $config).Hash
        $removed=Invoke-PBZMod Remove -GamePath $game -Apply
        Assert (!(Test-Path -LiteralPath $dll) -and !(Test-Path -LiteralPath $js)) 'Remove failed'
        Assert ((Get-FileHash -LiteralPath $config).Hash -eq $oldConfig -and (Test-Path -LiteralPath $exe)) 'Unrelated files changed'
        Invoke-PBZMod Restore -GamePath $game -Receipt $removed.Receipt -Apply|Out-Null
        Invoke-PBZMod Verify -GamePath $game|Out-Null
    }
    Check 'unknown and partial mod pairs are refused without overwrite' {
        $good=[IO.File]::ReadAllBytes($dll);[IO.File]::WriteAllText($dll,'unknown',$utf8)
        Expect-Error { Invoke-PBZMod Install -GamePath $game -Apply } 'Unknown'
        Assert ([IO.File]::ReadAllText($dll) -eq 'unknown') 'Unknown DLL was overwritten'
        [IO.File]::Delete($dll)
        Expect-Error { Invoke-PBZMod Install -GamePath $game -Apply } 'partial'
        [IO.File]::WriteAllBytes($dll,$good)
    }
    Check 'complete known previous pair upgrades and preserves personal settings' {
        $lockPath=Join-Path $copy 'bundle.lock.json';$savedLock=[IO.File]::ReadAllBytes($lockPath)
        [IO.File]::WriteAllText($dll,'previous fixture DLL',$utf8);[IO.File]::WriteAllText($js,'previous fixture JS',$utf8)
        $lock=Get-Content -LiteralPath $lockPath -Raw|ConvertFrom-Json
        $files=@{'platform/steam/hid.dll'=(Get-FileHash -LiteralPath $dll).Hash;'ProjectPBZ/Content/JavaScript/JidonPBZ/boot.js'=(Get-FileHash -LiteralPath $js).Hash}
        $lock.previous_bundles=@(@{version='fixture';files=$files});Save-Json $lockPath $lock
        $upgraded=Invoke-PBZMod Install -GamePath $game -Apply
        Assert ($upgraded.Changes.Count -eq 2) 'Upgrade did not replace exact pair'
        Assert ((Get-Content -LiteralPath $config -Raw|ConvertFrom-Json).deflect -eq 1.5) 'Upgrade lost personal settings'
        [IO.File]::WriteAllBytes($lockPath,$savedLock)
    }
    Check 'unsupported game, altered bundle, and legacy mod are blocked' {
        $originalExe=[IO.File]::ReadAllBytes($exe);[IO.File]::WriteAllText($exe,'different build',$utf8)
        Expect-Error { Invoke-PBZMod Install -GamePath $game -Apply } 'Unsupported'
        [IO.File]::WriteAllBytes($exe,$originalExe)
        $bundleDll=Join-Path $copy 'dist/hid.dll';$good=[IO.File]::ReadAllBytes($bundleDll)
        [IO.File]::WriteAllText($bundleDll,'corrupt download',$utf8)
        Expect-Error { Invoke-PBZMod Install -GamePath $game -Apply } 'integrity'
        [IO.File]::WriteAllBytes($bundleDll,$good)
        $legacy=Join-Path $game 'ProjectPBZ/Content/JavaScript/PBZModsMenu';[IO.Directory]::CreateDirectory($legacy)|Out-Null
        Expect-Error { Invoke-PBZMod Install -GamePath $game -Apply } 'third-party'
        [IO.Directory]::Delete($legacy)
    }
    Check 'invalid JSON settings and unsafe destinations are rejected' {
        $old=[IO.File]::ReadAllBytes($config);$cfg=Get-Content -LiteralPath $config -Raw|ConvertFrom-Json;$cfg.speed=0;Save-Json $config $cfg
        Expect-Error { Invoke-PBZMod Verify -GamePath $game } 'Invalid setting'
        $cfg.speed=@(0.5);Save-Json $config $cfg
        Expect-Error { Invoke-PBZMod Verify -GamePath $game } 'Invalid setting'
        [IO.File]::WriteAllBytes($config,$old)
        Expect-Error { & $module {param($r) Get-SafePath $r '../escape'} $game } 'Unsafe'
        Expect-Error { Invoke-PBZMod Restore -GamePath $game -Receipt (Join-Path $scratch 'untrusted.json') } 'Receipt must'
    }
    Check 'running game guard prevents mutations' {
        & $module { function script:Get-PbzProcesses { return @([pscustomobject]@{ProcessName='PBZ';Id=12345}) } }
        $before=(Get-FileHash -LiteralPath $config).Hash
        Expect-Error { Invoke-PBZMod Import -GamePath $game -Apply } 'Close Phantom'
        Assert ((Get-FileHash -LiteralPath $config).Hash -eq $before) 'Running guard wrote config'
        & $module { function script:Get-PbzProcesses { return @() } }
    }
    Check 'write failure rolls back files written earlier in the operation' {
        $originalWriter=& $module { ${function:Write-AtomicBytes}.ToString() }
        & $module {
            $script:RealWriter=${function:Write-AtomicBytes}
            function script:Write-AtomicBytes([string]$Path,[byte[]]$Bytes) {
                if ($Path.EndsWith('\z-fail.bin')) { throw 'injected disk failure' }
                & $script:RealWriter $Path $Bytes
            }
        }
        $payload=@{'one.bin'=[byte[]](1,2,3);'z-fail.bin'=[byte[]](4,5)}
        Expect-Error { & $module {param($g,$p) Invoke-Changes $g $g $p @() 'fixture' $true} $game $payload } 'injected disk'
        Assert (!(Test-Path -LiteralPath (Join-Path $game 'one.bin'))) 'Rollback left new file'
        & $module { param($body) Set-Item -Path Function:script:Write-AtomicBytes -Value ([scriptblock]::Create($body)) } $originalWriter
    }
    Check 'Steam library parsing handles current and legacy layouts' {
        $vdf=Join-Path $scratch 'libraryfolders.vdf'
        [IO.File]::WriteAllText($vdf,'"libraryfolders" { "1" { "path" "D:\\Steam Library" } "2" "E:\\Old Library" }',$utf8)
        $paths=@(& $module {param($p) Read-SteamLibraryPaths $p} $vdf)
        Assert ($paths.Count -eq 2 -and $paths[0] -eq 'D:\Steam Library' -and $paths[1] -eq 'E:\Old Library') 'Library paths incorrect'
    }
    Check 'plain Windows PowerShell entry point runs from path with spaces and brackets' {
        $output=& powershell.exe -NoProfile -File (Join-Path $copy 'tools/windows_mod_manager.ps1') -Action Verify -GamePath $game
        Assert ($LASTEXITCODE -eq 0) ($output -join "`n")
        Assert (($output -join "`n") -match 'MATCH') 'Entry point did not verify'
    }
    Write-Output "$count Windows PowerShell 5.1 installer tests passed; disposable files only, game code never executed."
} finally {
    if ($module) { Remove-Module $module -Force }
    # Only this generated test root is eligible for recursive deletion.
    $absolute=[IO.Path]::GetFullPath($scratch)
    $tempBase=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if ($absolute.StartsWith($tempBase,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $absolute -Leaf) -like 'pbz-portable-tests-*') {
        if (Test-Path -LiteralPath $absolute) { Remove-Item -LiteralPath $absolute -Recurse -Force }
    } else { throw 'Unsafe test cleanup path.' }
}
