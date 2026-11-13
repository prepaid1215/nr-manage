# NRC Sync 구버전 Python 서버 충돌 방지

2026-11-09 사용자 PC에서 최신 EXE(2026110804)를 실행했음에도 127.0.0.1:5050/health가 404를 반환했다.
실제로는 pythonw.exe -B C:\Users\user\Downloads\NRC-Sync-Desktop\api.py가 5050 포트를 사용했다.
Werkzeug 3.1.8 응답이었지만 새 EXE의 독립 Windows 테스트는 3.1.9, 정상 HTTP 200이었다.

## 새 코드

1. 실제 Flask 바인드 주소 127.0.0.1:5050이 사용 중인지 검사한다.
2. IPv4 루프백 수신을 하는 모든 PID의 프로세스 이름, 커맨드라인, Windows 소유자를 확인한다.
3. 같은 사용자의 python.exe/pythonw.exe가 정확히 NRC-Sync-Desktop\api.py를 실행 중인 경우에만 확인 대화상자를 연다.
4. 진행 중인 수집 중단 위험을 표시하고, 사용자가 동의한 경우에만 종료 직전 프로세스 정체를 재검증하여 종료한다.
5. 포트가 비워진 뒤 신버전 실행을 계속한다. 다른 Python 앱이나 확인 불가 프로세스는 절대 종료하지 않는다.
6. 구버전 시작프로그램(VBS/CMD/BAT/PS1) 또는 HKCU Run 값 중 정확한 구버전 경로가 확인된 것만 백업 후 비활성화한다.

## 제한

- 작업 스케줄러, LNK 바로가기, Windows 서비스 및 별도의 재실행 감시 프로그램은 자동 비활성화하지 않는다.
  이런 환경에서는 해당 자동 시작 설정을 별도 확인해야 한다.
- 진행 중인 수집을 정상 종료시키는 구버전 API가 없어, 전환 시 사용자가 수집이 끝났는지 확인해야 한다.
- 새 EXE가 다른 Windows 앱의 포트를 선점하거나 해당 앱을 종료하는 기능은 없다.
- PC 데이터/자격 증명/등록된 기기는 삭제하지 않는다.
- 이 코드가 GitHub에 반영돼도 이미 배포된 EXE는 변하지 않는다.
  빌드된 후보의 Windows 실사용 확인, Defender 검사, 기존 설정 보존을 검증한 뒤 새 버전을 게시해야 한다.

## 검증

Windows GitHub Actions에서 test_legacy_port.py가 가짜 구버전 pythonw.exe를 실행해 실제 5050 소유자를 식별하고
사용자 동의 후 해당 프로세스만 종료하는 테스트를 수행한다.
windows-exe-http-smoke.ps1은 빌드된 실행파일에 대해 /health, /update-status, /setup, /notes, /api/status를 확인한다.
운영 중인 EXE는 검증 완료 전 교체하지 않는다.
