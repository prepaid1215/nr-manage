# 회원별 회선 수 누락 수정 (2026-11-08)

> 이 문서는 최초 수정 당시의 기록이다. 아래의 `20261108-line-metrics-2` EXE는 이후 Defender 탐지로 배포를 중단했다.
> 현재 버전·검사 결과·분리된 빌드 절차는 [최신 인계](CLAUDE_CODE_HANDOFF_2026-11-08.md)와
> [설치파일 안내](../sync-client/installer/README.md)를 따른다. 아래의 전역 Python 직접 빌드 명령을 현재 배포 절차로 사용하지 않는다.

NRC 회원 상세 화면과 앱에서 같은 회원을 비교했을 때 소비자 총회선은 5로 같지만 실회선은 NRC 5, 앱 0이었다.

## 원인과 변경

NRC 화면의 실제 항목 이름은 아래와 같다. 기존 수집기는 총회선 키만 인식하고 다른 항목은 찾지 못했는데, 총회선 하나만 존재해도 `lineMetricsFound=true`로 설정하고 나머지를 0으로 채웠다. 앱은 이 0을 실제 회선 수로 표시했다.

| 원본 항목 | NRC 키 | 수집 결과 |
|---|---|---|
| 소비자 총 회선 | `totalLineCnt` | `consumerTotalLines` |
| 실회선 | `telCnt` | `realLines` |
| 본인 매출 회선 | `acGrpCnt` | `ownSalesLines` |
| 정기 배송 회선 | `autoCnt` | `regularDeliveryLines` |

- 원본 키와 기존 알려진 별칭을 정확히 읽으며 선택한 회원의 `rstSalesMap` 값을 우선한다.
- 누락된 항목은 null, 명시적으로 읽은 0은 숫자 0으로 구분한다.
- 새 자료에 `lineMetricsVersion=2`, 항목별 `lineMetricsAvailable`, `collectorVersion`을 기록한다.
- 이전 자료의 실회선·본인매출·정기배송 0은 미수집으로 표시한다. 새 수집기로 다시 받은 실제 0은 정상적으로 0회선으로 표시한다.
- KT/LG별 수는 실제로 확보한 회선 목록에 있는 경우에만 표시한다. 회원 상세의 실회선 5만으로 KT/LG를 임의 분배하지 않는다.

## 수집기 업데이트

수집은 Windows의 EXE가 수행하므로 웹 화면이나 Render 서버만 바꿔서는 새 항목이 수집되지 않는다. 각 수집 PC에서 최신 `installer/NRCSync.exe`를 실행해야 한다. 기존 PC 등록·자격 증명은 유지한다.

수집기 버전: `20261108-line-metrics-2`. 실행 중인 새 프로그램의 `http://127.0.0.1:5050/health`가 이 버전을 반환한다. 배포 EXE의 해시와 크기는 `installer/version.json`에 기록한다.

한 파일로 빌드된 EXE의 임시 압축 해제 경로 대신 `%LOCALAPPDATA%\ms-playwright`에 설치된 브라우저를 사용한다. 설치 완료 표시 파일만으로 브라우저가 있다고 판단하지 않고 현재 Playwright 버전의 실행 파일 존재도 확인한다.

재현 가능한 빌드 명령 (`v2/sync-client`에서 실행):

```powershell
python -m PyInstaller --noconfirm --clean --onefile --windowed --name NRCSync --icon app_icon.ico --add-data "app_icon.ico;." --collect-all playwright --hidden-import keyring.backends.Windows --hidden-import pystray._win32 --distpath installer api.py
```

## 검증

```powershell
python -m unittest discover -s v2/sync-client/tests -v
npm test --prefix v2/frontend
python v2/sync-client/tests/browser_line_metrics.py
```

실제 원본 필드, 부분 누락, 0, 잘못된 자료, 기존 별칭과 우선순위를 검사하고, 실제 조직 화면에 정상·이전·부분 자료를 각각 렌더링해 확인한다.
