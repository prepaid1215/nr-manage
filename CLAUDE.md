# NRC 사업관리 프로그램

작업을 시작할 때 다음 문서를 먼저 읽는다.

1. [최신 인계 문서 — 2026-11-28 (고객 방문 지점·고객 등록 화면·내 계보도 하위 총·교육 탭 스크롤)](v2/docs/CLAUDE_CODE_HANDOFF_2026-11-28.md)
2. [인계 문서 — 2026-11-24 (기록 탭·NRC 검색·등록 회원·수집기 로그)](v2/docs/CLAUDE_CODE_HANDOFF_2026-11-24.md)
3. [인계 문서 — 2026-11-09 (추가분)](v2/docs/CLAUDE_CODE_HANDOFF_2026-11-09.md)
4. [기준 인계 문서 — 2026-11-08](v2/docs/CLAUDE_CODE_HANDOFF_2026-11-08.md)
5. [기존 작업 기록](v2/docs/HANDOFF.md)
6. 기능에 따라 `v2/docs/account-recovery.md`, `v2/docs/line-metrics.md`, `v2/docs/closing-calculator.md`, `v2/docs/record-windows.md`, `v2/docs/tracked-members.md`

## 현재 구조

- 운영 코드는 `v2/`에 있다. 웹 화면은 프레임워크 없는 HTML/CSS/JavaScript ES modules다.
- `v2/frontend`: GitHub Pages 웹 앱.
- `v2/cloud-worker`: Render의 인증·작업 배정·결과 저장 API.
- `v2/sync-client`: 승인된 Windows PC에서 실제 NRC 수집을 실행하는 Python/Playwright 프로그램.
- `v2/supabase`: 운영 DB 변경 SQL, 마이그레이션, DB 검증 SQL.
- 실제 브라우저 수집은 승인된 Windows PC에서 한다. Render의 `RUN_BROWSER_WORKER`는 운영상 `false`다.

## 유지할 동작

- 수집을 요청한 현재 노트북/PC의 NRC Sync를 먼저 사용한다. 대기 중 15초 안에 응답하지 않으면 다른 승인 PC로 넘긴다.
- 일반 사용자는 본인 PC, 관리자는 전체 PC를 등록 해제·다시 등록할 수 있다. 해제 기록을 물리 삭제해 자동 재등록을 허용하면 안 된다.
- 회선의 실제 `0`과 수집되지 않은 값을 구분한다. 구버전 수집 결과로 정상 회선 값을 덮어쓰면 안 된다.
- 마감 계산 박스에는 서브1·서브2와 실회선을 표시한다. 대실적·소실적 계산 자체는 내부에서 계속 사용한다.
- 계보도 박스의 연결선 위 "하위 총 ○○"(이 박스 아래 전체 실적 합계)는 실적 > 추천제외 탭(`closing-lab.js`)과 내 계보도(`box-tree.js`의 `edgeTotals` 옵션, `custom-tree.js`에서만 켬)에 표시한다. 맨 위 박스에는 붙이지 않는다.
- 교육 탭은 가이드 원본(`education/index.html`, 파일은 고치지 않음)을 iframe으로 넣는다. 안쪽 스크롤 없이 바깥 페이지 스크롤 하나만 쓰도록 `education.js`의 `autoSize`가 iframe 높이를 내용 길이에 맞추고, 원본의 `scrollTo`·`scrollY`를 바깥 페이지 기준으로 바꾼다. 원본의 팝업(이미지 확대·편집)은 iframe 화면 가운데에 뜨므로 열려 있는 동안만 iframe을 화면 높이로 줄이고 닫으면 되돌린다. 원본에 `100vh`를 쓰는 CSS가 늘면 높이가 계속 커지니 `.layout{min-height:0}`처럼 덮어쓴다.
- 기록 탭 날짜별 표: 사람 탭을 끌거나 선택한 탭의 ◀▶로 순서를 바꾸고(`records-logic.js`의 `moveCode`·`dropCode`) 순서는 계정별로 이 브라우저에 저장한다(`nrc.records.tabs.<계정>`). PC(1000px 이상)에서는 표 안쪽 스크롤 없이 페이지 스크롤 하나만 쓴다(`.rc-wrap`이 `overflow:visible`). 머리글·날짜 열이 화면에 붙어 따라오게 하는 `position:sticky`가 중간 스크롤 칸이 생기면 깨지니, 표를 감싸는 요소에 `overflow`를 주지 않는다. 날짜 열은 내용 폭만 쓴다. 새 규칙(11/23 이후) 최종마감 줄의 설명은 "N차(마감)"이다.
- 마감 > 월 마감매출: 빈 칸을 기록 탭의 내 서브1·서브2(프로필 회원번호 +1, +2)의 총실적으로 자동으로 채운다(`finance.js`의 `autoFillFromRecords`). 자동매출은 마감일 당일 저녁 기록(마감 전), 마감매출은 최종마감 기록(마감 후)이고, 이미 저장한 값은 덮어쓰지 않으며 "전체 저장"을 눌러야 저장된다. 저장 위치는 첫째 칸(`*_a`)=서브1, 둘째 칸(`*_b`)=서브2이고, 칸 이름의 대실적·소실적은 두 값을 비교해 붙인다(서브코드 표시 방식은 `closingLabelStyle`로 이 브라우저에 저장).
- 홈 "오늘 현황" 카드 색은 `app.css`의 `#content.home-view .hero`가 정하는 값이 `theme.css`를 덮어쓰므로, 색을 바꿀 때는 `theme.css`에서 같은 선택자(`#content.home-view .hero`)로 지정한다. 지금은 어두운 남색에서 파란색으로 가는 그라데이션이다.
- 고객 탭의 `+ 고객 등록` 버튼(`#customerAdd`)은 접히는 "고객 관리" 박스 밖, "내 고객·공유 고객·알림 대상만" 탭 줄 오른쪽 끝에 항상 보인다. 신규개통양도·재구매양도·엑셀 가져오기·양식 다운로드는 접힌 박스 안에 둔다. 다른 사람 고객을 읽기 전용으로 볼 때는 탭 줄과 함께 숨긴다.

## 개발·배포 주의사항

- 먼저 `git status`와 최근 커밋을 확인하고 사용자 변경을 보존한다.
- 운영 DB에는 RUN_046~RUN_058 변경이 모두 적용돼 있다(11/28 확인). 전체 SQL 재실행이나 DB 초기화를 하지 않는다.
- RUN 번호는 파일 이름으로 겹치지 않게 쓴다. 새 SQL은 저장소의 가장 큰 번호 다음 번호로 만든다(RUN_055가 두 파일에 쓰여 RUN_058로 바꾼 적이 있다).
- 고객 등록의 "방문 지점"(`customers.visit_branch`, RUN_058)은 개통방법이 "지점방문"일 때만 보인다. 후보 목록은 BP FINDER+(`https://bp-finder.vercel.app/data/centers.json`)의 센터명이며 브라우저에 계속 저장하고 뒤에서 갱신한다. 규칙은 `v2/frontend/js/customer-visit.js`, 테스트는 `v2/frontend/tests/customer-visit.test.mjs`다. 열이 없는 DB에서는 메모 끝에 "방문 지점: ○○"으로 저장한다.
- 새 표를 만들면 `authenticated`뿐 아니라 Render 서버가 쓰는 `service_role`에도 GRANT한다(빠뜨리면 서버가 오류를 삼켜 기능이 조용히 안 된다).
- 프런트엔드 변경 시 실제 수정 모듈의 import `?v=`와 `index.html`의 앱 버전을 함께 갱신한다. 같은 `?v=` 값으로 내용만 바꾸면 브라우저가 옛 파일을 쓰니 반드시 올린다.
- Windows EXE는 `requirements-build.txt`로 만든 별도 환경에서 `build_release.py`로 빌드한다. 후보 파일의 Defender 검사와 해시 검증 후 동일한 파일만 게시한다.
- 이전 EXE에 실제 Defender 탐지가 있었다. 격리 복원·백신 예외 추가·보호 해제는 하지 않는다.
- 계정 비밀번호, 갱신 토큰, service-role 키, 암호화 키를 소스·문서·로그에 넣지 않는다. 기존 암호화 키를 재생성하면 저장된 승인정보를 복호화하지 못할 수 있다.
- 사용자에게 특정 PC 해제를 요청받기 전에는 실제 등록 PC를 임의로 해제하지 않는다.

테스트와 배포 절차, 현재 버전·알려진 제한은 최신 인계 문서에 있다.
