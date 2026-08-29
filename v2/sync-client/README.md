# NRC Sync Desktop

PC에서 Playwright로 NRC 홈페이지 데이터를 수집하고 Supabase에 저장하는 로컬 동기화 프로그램입니다.

## 최초 설치

```powershell
python -m pip install -r requirements.txt
python -m playwright install chromium
python setup_sync.py
python api.py
```

서버가 실행된 뒤 브라우저에서 `http://127.0.0.1:5050/setup`을 열고 다음 정보를 한 번 저장합니다.

- 이 PC 이름
- NRC 관리 앱 아이디·비밀번호
- 이 PC가 수집할 NRC 홈페이지 아이디·비밀번호

연결 코드는 사용하지 않습니다. 여러 PC에서 같은 앱 계정으로 등록하면 켜져 있는 PC 중
요청한 NRC 계정을 보유한 한 대가 Supabase 작업을 자동으로 가져갑니다.

## 사용 방식

- 즉시 수집: 휴대폰이나 어떤 PC의 웹앱에서 `수집`을 누르면 작업이 Supabase에 등록됩니다.
- 등록 PC는 5초마다 작업을 확인하고, 한 PC만 원자적으로 선점해 Playwright 수집을 실행합니다.
- NRC 비밀번호와 Supabase 갱신 토큰은 등록 PC의 Windows 자격 증명 저장소에만 보관됩니다.
- 모든 등록 PC가 꺼져 있으면 요청은 대기하고, 해당 NRC 계정의 PC가 켜지면 처리됩니다.
