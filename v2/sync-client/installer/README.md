# NRC Sync 설치파일

새 PC를 공유 수집 PC로 등록할 때, Python을 따로 설치하지 않고 이 폴더의 파일 3개만
그 PC에 복사해서 쓰면 됩니다.

## 설치 방법 (해당 PC에서)

1. `NRCSync.exe`, `run_hidden.vbs`, `Install-NRCSync.ps1` 세 파일을 그 PC의 아무 폴더에나
   같이 복사합니다(바탕화면 등).
2. `Install-NRCSync.ps1`을 마우스 오른쪽 클릭 → **PowerShell로 실행**을 누릅니다.
   - "실행 정책" 경고가 뜨면, PowerShell 창에서 아래 명령을 한 번 입력하고 다시 시도하세요.
     ```powershell
     Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
     ```
3. 설치가 끝나면 자동으로 브라우저가 열리며 `http://127.0.0.1:5050/setup` 등록 화면이 뜹니다.
   - PC 이름, 관리 앱 아이디/비밀번호, 이 PC가 수집할 NRC 홈페이지 아이디/비밀번호를 입력하고
     **이 PC 등록하기**를 누르면 끝입니다.

## 이후 동작

- Windows에 로그인할 때마다 `NRCSync`가 자동으로 조용히(창 없이) 백그라운드에서 실행됩니다.
- 이 PC를 켜두는 동안은 "온라인" 상태로 잡혀서 공유 수집 요청을 처리할 수 있습니다.
- 별도로 실행할 필요가 없습니다. 껐다 켜도 다시 자동으로 시작됩니다.

## 확인/제거

- 실행 중인지 확인: 작업 관리자에서 `NRCSync.exe` 프로세스 확인
- 자동 실행 껐다 켜기: 작업 스케줄러(`taskschd.msc`)에서 `NRCSync` 작업을 사용/사용 안 함으로 전환
- 완전히 제거: 작업 스케줄러에서 `NRCSync` 작업 삭제 후, `%LOCALAPPDATA%\NRCSync` 폴더 삭제
