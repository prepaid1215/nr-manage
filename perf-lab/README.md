# perf-lab

실적/마감 계산 로직을 앱 밖에서 검증하는 실험 폴더.

실제 조직 데이터(`real-org-data.js`, `app-mirror/js/real-org-data.js`, `real-org.json`)는
개인정보라 저장소에 없다. 수집 JSON을 `const REAL_ORG_DATA = {...};` 형태로 저장해서
위 경로에 직접 넣어야 `app-mirror`, `real-org-test.html`, `income-check.html`이 동작한다.

실행: `cd app-mirror && python -m http.server 8737` → http://localhost:8737
