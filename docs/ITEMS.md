# 선택 사항: 이동·초기화 부적 99개

요약 → 사용 방법 → 검증·출처 순서입니다. 전투 로더를 설치하는 데 필요하지 않습니다.

## 요약

이어하기 슬롯에 등록된 공간 이동 부적, 병기 역련부, 팬텀 소거 부적 수량을 총 99개로 맞춥니다. +99개 지급이나 무한 사용이 아닙니다. 장신구 초기화·강화 수준·다른 아이템은 변경하지 않습니다. 개인 세이브를 GitHub로 전송하지 않습니다.

## 사용

게임을 종료하고 Steam Cloud 동기화를 마친 뒤 사용하세요. 도구가 Cloud를 검사하지는 않습니다. 같은 세이브에 이미 지급됐다면 다시 실행할 필요가 없습니다. 대상 수량이 하나라도 99 이상이면 중단합니다.

최초 준비에서 약 44MB의 PBZ Editor 공식 배포 ZIP을 내려받아 고정 해시를 검사하고 디코더만 꺼냅니다. 편집기 실행 파일을 실행하거나 게임 폴더에 넣지 않습니다. 이 디코더는 별도 제3자 의존성입니다.

```powershell
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-save.txt
.venv\Scripts\python.exe tools/setup_save_tool.py
$game = 'D:\Program Files (x86)\Steam\steamapps\common\PBZ'
.venv\Scripts\python.exe -X utf8 tools/supply_items.py --game $game --include-reforge
.venv\Scripts\python.exe -X utf8 tools/supply_items.py --game $game --include-reforge --apply
```

`--apply` 전에는 미리보기만 만듭니다. `--include-reforge`를 빼면 이동 부적만 변경합니다. 계정이 여러 개면 `--save '실제 PBZSaveGame.sav 경로'`를 추가합니다. Python `-O`는 지원하지 않습니다.

전체 계정 세이브를 `.local/item-supply` 아래 실행별 백업에 보관합니다. 복구하려면 게임 종료 후 현재 세이브를 따로 보관하고 영수증에 기록된 백업을 원래 위치로 복사합니다. 백업 이후 진행은 사라집니다.

## 검증·출처

게임 파일에서 읽은 키 후보로 세이브 인증에 성공해야 진행하며 키를 저장소에 기록하지 않습니다. 이어하기 슬롯과 기존 아이템 레코드가 명확해야 합니다. 수량·최대 보유 기록·변경 시각만 갱신하고 다른 슬롯 암호화 블록과 나머지 JSON 바이트를 보존한 뒤 다시 해독해 비교합니다. 파일 검증은 게임 로드 검증과 다릅니다.

`vendor/pbz-editor`는 [PBZ Editor](https://github.com/qry6868/PBZ-Editor)의 커밋 `5fdb13483cefde94e6a2f3dba3d258c84e747582`에서 저장 처리 Python 4개와 프로필을 가져왔으며 MIT 라이선스를 보존했습니다. 디코더 v0.3.0의 해시는 `tools/setup_save_tool.py`에 있습니다. 이 디코더는 자체 게임 로더 `dist/hid.dll`과 다른 파일입니다.
