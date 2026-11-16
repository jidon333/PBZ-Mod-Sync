#requires -Version 5.1
param([ValidateSet('Menu','Install','Verify','Import','Export','Remove','Restore')][string]$Action='Menu', [string]$GamePath, [switch]$Apply, [string]$Receipt)
$ErrorActionPreference='Stop'
function Show-OperationError($Failure) {
    $message=$Failure.Exception.Message
    $hint=switch -Regex ($message) {
        'Unsupported game version' { '지원하지 않는 게임 버전입니다. 지원 빌드용 묶음이 필요합니다.';break }
        'Close Phantom Blade' { '게임을 완전히 종료한 뒤 다시 실행하세요.';break }
        'Unknown or partial|third-party mod' { '기존의 다른 모드 또는 불완전한 설치를 발견했습니다. 자동으로 덮어쓰지 않습니다.';break }
        'integrity|Incomplete bundle' { '배포 파일이 빠졌거나 내용이 다릅니다. GitHub ZIP 전체를 다시 압축 해제하세요.';break }
        'newer work' { '백업 이후 파일이 변경됐습니다. 더 최근의 변경을 보호하기 위해 복구를 중단했습니다.';break }
        'Invalid setting|Settings file' { '설정 파일을 읽을 수 없거나 값이 허용 범위를 벗어났습니다.';break }
        default { '작업을 완료하지 못했습니다. 아래 원인을 확인하세요.' }
    }
    Write-Host $hint -ForegroundColor Red
    Write-Host $message
}
try {
    Import-Module (Join-Path $PSScriptRoot 'WindowsMod.psm1') -Force
    if (!$GamePath) {
        $found=@(Find-PBZGame)
        if ($found.Count -eq 1) { $GamePath=$found[0] }
        elseif ($Action -ne 'Menu') { throw 'Pass -GamePath with the Steam PBZ folder.' }
        else {
            if ($found.Count) { $found | ForEach-Object { Write-Host $_ } }
            $GamePath=(Read-Host 'PBZ 게임 폴더 경로 (ProjectPBZ가 들어 있는 폴더)').Trim().Trim('"')
        }
    }
    if ($Action -ne 'Menu') {
        Invoke-PBZMod -Action $Action -GamePath $GamePath -Apply:$Apply -Receipt $Receipt | ConvertTo-Json -Depth 8
        exit 0
    }
    while ($true) {
        Write-Host "`nJidon PBZ 모드 관리" -ForegroundColor Cyan
        Write-Host "게임: $GamePath"
        Write-Host '1 설치 / 업데이트 (개인 설정 유지)'
        Write-Host '2 설치 검사'
        Write-Host '3 이 폴더의 설정을 게임에 적용'
        Write-Host '4 게임 설정을 이 폴더로 내보내기'
        Write-Host '5 자체 로더 제거 (설정·세이브 유지)'
        Write-Host '6 백업 기록으로 되돌리기'
        Write-Host '0 종료'
        $choice=Read-Host '번호'
        if ($choice -eq '0' -or $null -eq $choice) { break }
        $map=@{'1'='Install';'2'='Verify';'3'='Import';'4'='Export';'5'='Remove';'6'='Restore'}
        if (!$map.ContainsKey($choice)) { continue }
        try {
            $operation=@{Action=$map[$choice];GamePath=$GamePath}
            if ($choice -eq '6') { $operation.Receipt=(Read-Host '백업 receipt.json 전체 경로').Trim().Trim('"') }
            $preview=Invoke-PBZMod @operation
            if ($choice -eq '2') { $preview | ConvertTo-Json -Depth 8 | Write-Host;Write-Host '파일과 설정 검사 통과' -ForegroundColor Green;continue }
            if (!$preview.Changes.Count) { Write-Host '이미 일치합니다. 변경할 파일이 없습니다.';continue }
            Write-Host '변경할 파일:'; $preview.Changes | ForEach-Object { Write-Host "  $_" }
            if ((Read-Host '진행하려면 Y 입력') -ne 'Y') { continue }
            $result=Invoke-PBZMod @operation -Apply
            if ($choice -in @('1','3')) { Invoke-PBZMod -Action Verify -GamePath $GamePath | Out-Null }
            Write-Host '완료' -ForegroundColor Green
            if ($result.Receipt) { Write-Host "복구 기록: $($result.Receipt)" }
            if ($choice -eq '1') { Write-Host 'Steam에서 게임 실행 → F9 또는 설정의 전투 보조 탭' }
            if ($choice -eq '4') { Write-Host '내보내기만 완료했습니다. 다른 PC로 옮기려면 settings 폴더를 GitHub에 반영하세요.' }
        } catch { Show-OperationError $_ }
    }
} catch { Show-OperationError $_; exit 1 }
