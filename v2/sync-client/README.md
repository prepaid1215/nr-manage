# NRC Sync Desktop

PC에서 Playwright로 NRC 홈페이지 데이터를 수집하고 Supabase에 저장하는 로컬 동기화 프로그램입니다.

## 최초 설치

```powershell
python -m pip install -r requirements.txt
python -m playwright install chromium
python setup_sync.py
python api.py
```

`setup_sync.py`가 보여주는 연결 코드를 웹앱의 `설정 > 내 컴퓨터 연결`에 저장합니다.

## 사용 방식

- 즉시 수집: 웹앱 `수집` 탭에서 NRC 홈페이지 아이디와 비밀번호를 입력하고 `RUN`을 누릅니다.
- 자동 수집: 같은 탭에서 NRC 계정과 매일 실행 시간을 예약합니다.
- 자동수집 비밀번호와 Supabase 갱신 토큰은 Windows 자격 증명 저장소에만 보관됩니다.
- PC가 꺼져 있으면 실행되지 않으며, 다시 켜면 당일 놓친 예약을 보충 실행합니다.
