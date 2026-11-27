# 수집 PC 로그인 세션 분리 — 수정 방안 (초안, 2026-11-27)

아직 구현하지 않았다. 사용자가 방안을 고르면 단계별로 진행한다.

## 1. 문제

`이 PC 자동 등록`(`queue_worker.py: configure_worker_from_session`)은 **웹 브라우저에 로그인된 Supabase 세션의 갱신 토큰을 그대로 PC 키링에 복사**한다.
PC와 브라우저가 같은 토큰 줄기를 쓰므로, 한쪽이 갱신하면 다른 쪽 토큰은 `refresh_token_already_used`가 된다.
재사용이 감지되면 세션 전체가 끊겨 PC와 웹이 함께 "로그아웃"될 수 있다.

- 증상(2026-11-27 집 PC): 프로세스는 떠 있는데 로그에 `refresh_token_already_used`(400)가 반복되고 웹 PC 목록의 마지막 확인이 11/26 10:21에서 멈춤.
- 시작 시점은 11/26 10:19 서버 502 오류 부근이다. 충돌 순간의 로그는 없어 **정확한 계기는 추정**이다.
- 수집기는 서버(Render)·Supabase REST 호출에 모두 `_access_token()`(사용자 세션)을 쓴다. 서버의 `user_from_request()`도 `/auth/v1/user`로 사용자 JWT만 검증한다. 즉 "PC 전용 자격"이 아직 없다.
- `_json_request`는 HTTP 오류(502 등)를 재시도하지 않는다. 갱신 응답이 유실되면 새 토큰을 못 받고 옛 토큰만 남는다.

## 2. 방안 (권장 순서)

### A. 단기 완화 (수집기만, 작음)
1. 토큰 갱신(`_access_token`)에서 5xx·연결 오류·타임아웃이면 **같은 토큰으로 2~3초 간격 재시도**(최대 3회). Supabase는 기본 10초 동안 같은 토큰 재사용을 허용하므로 응답 유실을 복구할 수 있다.
2. `refresh_token_already_used`/`invalid refresh token`이면 반복 로그 대신 상태를 `needs_reregister`로 두고, 로그에 한 번만 "이 PC를 다시 등록하세요"를 남기며 하트비트를 중단한다(5분 쓰로틀 유지).
3. 웹 PC 목록에서 이 상태를 "재등록 필요"로 보이게 하려면 서버가 마지막 하트비트 시각만 알고 있어 별도 표시가 필요하다(선택).

### B. 근본 수정 (서버 + 수집기)
PC가 **자기 전용 세션**을 갖게 한다. 비밀번호 없이 만드는 방법:

1. 서버에 `POST /devices/session-ticket` 추가. 호출자는 웹 사용자 JWT(`user_from_request`)로 확인한다.
2. 서버가 service-role로 Supabase Admin `generate_link`(type `magiclink`)를 호출해 해당 사용자의 `hashed_token`을 받아 반환한다(메일은 발송되지 않는다).
3. PC가 `/auth/v1/verify`(`token_hash`)로 교환해 **브라우저와 별개의 새 세션**(access+refresh)을 받아 키링에 저장한다. 브라우저 토큰은 저장하지 않는다.
4. `configure_worker_from_session`은 브라우저 `refreshToken`을 받지 않아도 되도록 바꾼다. 웹은 `accessToken`만 넘긴다.

효과: 브라우저와 PC가 서로의 갱신을 깨뜨리지 않는다. PC마다 독립 세션이다.

### C. 자동 복구 (선택, B 이후)
- 등록 때 서버가 PC 전용 비밀(무작위 값, DB에는 해시만 저장)을 발급해 PC 키링에 보관한다.
- 세션이 끊기면 PC가 `deviceId + 비밀`로 새 session-ticket을 요청해 **사람 개입 없이** 재로그인한다.
- 비밀 유출 시 그 PC만 서버에서 폐기할 수 있다. 등록 해제된 PC는 거부한다.

## 3. 선택지 비교

| | 변경 범위 | 효과 | 위험 |
|---|---|---|---|
| A만 | 수집기 | 502 같은 일시 오류 대부분 복구. 브라우저와의 충돌은 그대로 | 낮음 |
| A+B | 서버+수집기 | 브라우저 충돌 제거 | 중간(Render+EXE 동시 배포) |
| A+B+C | 서버+수집기+DB(SQL 1개) | 끊겨도 자동 재로그인 | 중간~높음(새 비밀 처리) |

## 4. 확인이 필요한 것 (구현 전)
- Supabase 프로젝트에서 `generate_link`(magiclink)가 앱 계정(`app-<아이디>@nrc-members.com`)에 동작하는지, 이메일 확인 설정이 막지 않는지. **작은 시험 호출로 먼저 검증**한다. 막히면 B는 다른 방식을 찾아야 한다.
- Supabase Auth 설정의 "Refresh token reuse interval" 값(기본 10초)과 "Detect and revoke compromised tokens" 사용 여부(대시보드에서 사용자가 확인).
- 사무실 PC도 같은 증상인지(사무실 PC 로그 필요).

## 5. 배포 시 주의 (CLAUDE.md)
- 서버(Render) 먼저, 수집기 EXE는 나중. 서버 엔드포인트는 기존 EXE와 호환되게 **추가만** 한다.
- 수집기 변경은 EXE 빌드·Defender 검사·해시 검증 후 게시한다. 푸시하면 모든 수집 PC에 자동 배포된다.
- 토큰·비밀·service-role 키를 소스·문서·로그에 넣지 않는다. 사용자가 요청하기 전에는 커밋·푸시하지 않는다.
- 새 테이블(C 단계에 필요하면)에는 `service_role` GRANT를 함께 넣는다.
