"""Supabase 작업 대기열을 소비하는 다중 PC NRC 수집기."""

import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

import keyring
import scraper as scraper_module
from scraper import run_combined
from work_guard import ACTIVITY
from sync_version import COLLECTOR_VERSION


SUPABASE_URL = "https://ymagjzwebshfnjiisrao.supabase.co"
SUPABASE_KEY = "sb_publishable_odxxHbBufV-ZSFlVJ8xFiw_18hBVyJf"
CLOUD_COORDINATOR = "https://nrc-sync-cloud-sg.onrender.com"
DATA_DIR = (
    Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "NRCSync" / "data"
    if getattr(sys, "frozen", False)
    else Path(__file__).parent / "data"
)
DEVICE_FILE = DATA_DIR / "worker_device.json"
SESSION_SERVICE = "NRC-Management-Worker-Session"
CREDENTIAL_SERVICE = "NRC-Management-Manual"

_auth_lock = threading.Lock()
_cached_auth = {}
# 갱신 토큰이 영구히 무효가 되면 needs 가 켜지고, 재등록하면 꺼진다. 그동안은 5분에 한 번만 서버에 다시 확인한다.
_session_state = {"needs": False, "checkedAt": 0.0}
REREGISTER_RECHECK_SECONDS = 300
_DEAD_REFRESH = re.compile(
    r"refresh_token_already_used|refresh_token_not_found|session_not_found|invalid_grant|Invalid Refresh Token|Refresh Token Not Found",
    re.I,
)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def log_event(message):
    """작업 수신·진행·실패를 시각과 함께 로그(nrcsync.log)에 남긴다."""
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


_throttle = {}


def log_throttled(key, message, interval=300):
    """같은 내용이 반복되면 interval초에 한 번만 남기고, 생략한 횟수를 다음 줄에 적는다.

    네트워크가 끊긴 PC가 5초마다 같은 오류를 남겨 로그를 덮는 것을 막는다.
    """
    now = time.time()
    entry = _throttle.get(key)
    if entry and entry["text"] == message and now - entry["at"] < interval:
        entry["suppressed"] += 1
        return
    extra = f" (같은 내용 {entry['suppressed']}회 생략)" if entry and entry["suppressed"] else ""
    _throttle[key] = {"text": message, "at": now, "suppressed": 0}
    log_event(message + extra)


RETRY_DELAY = 2  # 일시 오류 재시도 간격(초). Supabase는 같은 갱신 토큰을 10초간 다시 받아 준다.


class ServerError(RuntimeError):
    """서버가 HTTP 오류로 응답했다. 메시지 형식은 기존과 같고 status·detail을 따로 들고 있다."""

    def __init__(self, status, message, detail=""):
        super().__init__(f"서버 요청 실패({status}): {message}")
        self.status = status
        self.detail = detail


class ReregisterNeeded(RuntimeError):
    """이 PC의 로그인 세션이 영구히 끊겨 사람이 다시 등록해야 한다."""


def _json_request(url, method="GET", body=None, headers=None, timeout=60, retry=False):
    """retry=True는 같은 요청을 다시 보내도 안전한 호출(토큰 갱신·조회)에만 쓴다.
    5xx·연결 끊김·시간 초과를 최대 3번까지 2초 간격으로 다시 시도한다."""
    request_headers = {"Content-Type": "application/json", **(headers or {})}
    payload = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers=request_headers, method=method)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                text = response.read().decode("utf-8")
                return json.loads(text) if text else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            try:
                message = json.loads(detail).get("message") or detail
            except (json.JSONDecodeError, AttributeError):
                message = detail
            if retry and exc.code >= 500 and attempt < 2:
                time.sleep(RETRY_DELAY)
                continue
            raise ServerError(exc.code, message, detail) from exc
        except urllib.error.URLError as exc:
            if (retry or getattr(exc.reason, "winerror", None) == 10013) and attempt < 2:
                time.sleep(RETRY_DELAY if retry else attempt + 1)
                continue
            raise RuntimeError(f"서버 연결 실패: {exc.reason}") from exc
        except (TimeoutError, ConnectionError) as exc:
            if retry and attempt < 2:
                time.sleep(RETRY_DELAY)
                continue
            raise


def _load_device():
    if not DEVICE_FILE.exists():
        return None
    return json.loads(DEVICE_FILE.read_text(encoding="utf-8"))


def _save_device(device):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DEVICE_FILE.write_text(json.dumps(device, ensure_ascii=False, indent=2), encoding="utf-8")


def _session_key(device_id):
    return f"device:{device_id}"


def _finish_configure(user_id, access_token, refresh_token, expires_in, nrc_login_id, nrc_password, device_name=None):
    existing = _load_device() or {}
    device = {
        "id": existing.get("id") if existing.get("owner_id") == user_id else str(uuid.uuid4()),
        "owner_id": user_id,
        "device_name": str(device_name or socket.gethostname()).strip() or socket.gethostname(),
        "source_account_id": nrc_login_id,
    }
    _save_device(device)
    keyring.set_password(
        SESSION_SERVICE,
        _session_key(device["id"]),
        json.dumps({"userId": user_id, "refreshToken": refresh_token}),
    )
    keyring.set_password(
        CREDENTIAL_SERVICE,
        user_id,
        json.dumps({"loginId": nrc_login_id, "password": nrc_password}),
    )
    with _auth_lock:
        _session_state.update(needs=False, checkedAt=0.0)
        _cached_auth.clear()
        _cached_auth.update(
            accessToken=access_token,
            expiresAt=time.time() + int(expires_in or 3600) - 60,
            userId=user_id,
        )
    _coordinator("/devices/register", {"deviceId":device["id"], "deviceName":device["device_name"],
                                     "sourceAccountId":nrc_login_id, "collectorVersion":COLLECTOR_VERSION})
    heartbeat("ONLINE", None)
    return device


def configure_worker(app_username, app_password, nrc_login_id, nrc_password, device_name=None):
    username = str(app_username).strip().lower()
    nrc_login_id = str(nrc_login_id).strip()
    if len(username) < 4 or len(app_password) < 8:
        raise ValueError("앱 아이디와 비밀번호를 확인하세요.")
    if len(nrc_login_id) < 3 or len(nrc_password) < 4:
        raise ValueError("NRC 홈페이지 아이디와 비밀번호를 확인하세요.")

    auth = _json_request(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        method="POST",
        body={"email": f"app-{username}@nrc-members.com", "password": app_password},
        headers={"apikey": SUPABASE_KEY},
    )
    return _finish_configure(
        auth["user"]["id"], auth["access_token"], auth["refresh_token"], auth.get("expires_in"),
        nrc_login_id, nrc_password, device_name,
    )


def configure_worker_from_session(access_token, refresh_token, device_name=None, expires_in=None):
    """이미 웹 앱에 로그인된 브라우저 세션을 그대로 넘겨받아, 클라우드에 저장된
    본인의 NRC 로그인정보(공유 PC 수집 승인 시 저장됨)까지 자동으로 가져와
    입력창 없이 이 PC를 등록한다."""
    if not access_token or not refresh_token:
        raise ValueError("로그인 세션 정보가 없습니다. 웹 앱에 다시 로그인한 뒤 시도해 주세요.")
    user = _json_request(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {access_token}"},
        retry=True,
    )
    user_id = user["id"]
    creds = _json_request(
        f"{CLOUD_COORDINATOR}/credentials/reveal",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    rows = (creds or {}).get("credentials") or []
    if not rows:
        raise ValueError("먼저 앱의 설정 > 수집 탭에서 '공유 PC 수집 승인'을 진행한 뒤 다시 시도해 주세요.")
    chosen = rows[0]
    return _finish_configure(
        user_id, access_token, refresh_token, expires_in or 3600,
        chosen["loginId"], chosen["password"], device_name,
    )


def worker_configuration():
    device = _load_device()
    if not device:
        return {"configured": False}
    saved = keyring.get_password(SESSION_SERVICE, _session_key(device["id"]))
    return {"configured": bool(saved), **device}


def _access_token():
    device = _load_device()
    if not device:
        raise RuntimeError("이 PC가 아직 등록되지 않았습니다. NRC Sync 설정을 완료하세요.")
    with _auth_lock:
        if _cached_auth.get("accessToken") and _cached_auth.get("expiresAt", 0) > time.time():
            return _cached_auth["accessToken"]
        saved_text = keyring.get_password(SESSION_SERVICE, _session_key(device["id"]))
        if not saved_text:
            raise RuntimeError("이 PC의 앱 로그인이 필요합니다.")
        if _session_state["needs"] and time.time() - _session_state["checkedAt"] < REREGISTER_RECHECK_SECONDS:
            raise ReregisterNeeded("이 PC의 로그인 세션이 끊겼습니다. 웹 설정 > 수집에서 이 PC를 다시 등록하세요.")
        saved = json.loads(saved_text)
        try:
            auth = _json_request(
                f"{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
                method="POST",
                body={"refresh_token": saved["refreshToken"]},
                headers={"apikey": SUPABASE_KEY},
                retry=True,
            )
        except ServerError as exc:
            if exc.status in (400, 401) and _DEAD_REFRESH.search(exc.detail or str(exc)):
                _session_state.update(needs=True, checkedAt=time.time())
                log_throttled(
                    "needs-reregister",
                    "이 PC의 로그인 세션이 끊겼습니다(갱신 토큰 무효). 웹 설정 > 수집에서 '수동 등록'으로 다시 등록하세요.",
                    interval=3600,
                )
                raise ReregisterNeeded("이 PC의 로그인 세션이 끊겼습니다. 웹 설정 > 수집에서 이 PC를 다시 등록하세요.") from exc
            raise
        _session_state.update(needs=False, checkedAt=0.0)
        saved["refreshToken"] = auth.get("refresh_token", saved["refreshToken"])
        keyring.set_password(SESSION_SERVICE, _session_key(device["id"]), json.dumps(saved))
        _cached_auth.update(
            accessToken=auth["access_token"],
            expiresAt=time.time() + int(auth.get("expires_in", 3600)) - 60,
            userId=saved["userId"],
        )
        return _cached_auth["accessToken"]


def _rest(path, method="GET", body=None, prefer=None):
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {_access_token()}",
    }
    if prefer:
        headers["Prefer"] = prefer
    return _json_request(f"{SUPABASE_URL}/rest/v1/{path}", method, body, headers)


def _coordinator(path, body=None, timeout=60):
    return _json_request(
        f"{CLOUD_COORDINATOR}{path}",
        "POST",
        body or {},
        {"Authorization": f"Bearer {_access_token()}"},
        timeout=timeout,
    )


def heartbeat(status="ONLINE", error=None):
    device = _load_device()
    if not device:
        return
    result = _coordinator("/worker/heartbeat", {"deviceId":device["id"], "status":status,
                          "error":error, "collectorVersion":COLLECTOR_VERSION}) or {}
    revoked = bool(result.get("revoked"))
    if bool(device.get("revoked")) != revoked:
        device["revoked"] = revoked
        _save_device(device)
    return not revoked


def local_device_status():
    device = _load_device() or {}
    return {"deviceId":device.get("id"), "deviceRevoked":bool(device.get("revoked")),
            "needsReregister":bool(_session_state["needs"])}


def _patch_job(job_id, values):
    _rest(
        f"nrc_sync_jobs?id=eq.{urllib.parse.quote(str(job_id))}",
        "PATCH",
        {**values, "updated_at": utc_now()},
        "return=minimal",
    )


def claim_job():
    device = _load_device()
    if not device:
        return None
    if device.get("revoked"):
        return None
    started = time.time()
    result = _coordinator("/worker/claim", {"deviceId": device["id"],
                          "collectorVersion":COLLECTOR_VERSION, "lineMetricsVersion":2}) or {}
    elapsed = time.time() - started
    if elapsed > 8:
        # 요청한 PC 우선 배정은 15초 동안만 유지된다. 응답이 느리면 다른 PC로 넘어갈 수 있다.
        log_throttled("slow-claim", f"작업 요청 응답이 느립니다({elapsed:.0f}초). 우선 배정 15초를 놓칠 수 있습니다.")
    if result.get("updateRequired"):
        log_throttled("update-required", "서버가 이 수집기를 업데이트가 필요한 버전으로 판단해 작업을 주지 않았습니다.")
    return result.get("job")


def enqueue_due_schedules():
    device = _load_device()
    if device:
        _rest("rpc/enqueue_due_nrc_sync_schedules", "POST", {"p_device_id": device["id"]})


def _load_combined():
    path = DATA_DIR / "combined_latest.json"
    if not path.exists():
        raise RuntimeError("수집 결과 JSON이 만들어지지 않았습니다.")
    return json.loads(path.read_text(encoding="utf-8"))


def tracked_members_from_job(job):
    """서버가 작업과 함께 준 '표에 등록한 하위 회원' 목록을 걸러서 쓴다(숫자 회원번호만, 최대 150개)."""
    items = []
    for row in (job.get("trackedMembers") or [])[:150]:
        if not isinstance(row, dict):
            continue
        user_id = str(row.get("userId") or "")
        if not user_id.isdigit():
            continue
        items.append({
            "userId": user_id,
            "userName": str(row.get("userName") or "")[:30],
            "rankCd": str(row.get("rankCd") or "")[:4],
            "rankName": str(row.get("rankName") or "")[:20],
        })
    return items


def process_job(job):
    device = _load_device()
    credentials = job.get("credentials") or {}
    login_id = credentials["loginId"]
    requested_account = str(job.get("sourceAccountId") or "").strip()
    if requested_account and requested_account != login_id:
        raise RuntimeError("배정된 NRC 계정 정보가 일치하지 않습니다.")

    if not heartbeat("BUSY", None):
        raise RuntimeError("이 PC의 등록이 해제되어 수집을 중단했습니다.")
    tracked = tracked_members_from_job(job)
    log_event(f"수집 시작: 작업 {str(job.get('id'))[:8]} · NRC 계정 {login_id} · 등록 회원 {len(tracked)}개")
    started = time.time()
    try:
        (DATA_DIR / "combined_latest.json").unlink(missing_ok=True)
        scraper_module.USER_ID = login_id
        scraper_module.USER_PW = credentials["password"]
        scraper_module.TRACKED_MEMBERS = tracked
        try:
            run_combined()
        finally:
            scraper_module.TRACKED_MEMBERS = []
        data = _load_combined()
        collected_account = str(data.get("sourceAccountId") or login_id).strip()
        if collected_account != login_id:
            raise RuntimeError(
                f"요청 계정({login_id})과 수집 계정({collected_account})이 다릅니다."
            )
        log_event(
            f"수집 끝({time.time() - started:.0f}초): 계보 {len(data.get('rstLst') or [])}명 · "
            f"등록 회원 {len(data.get('trackedMembers') or [])}/{len(tracked)}개 읽음. 결과를 올립니다."
        )
        _coordinator(
            "/worker/complete",
            {
                "deviceId": device["id"],
                "jobId": job["id"],
                "leaseToken": job["leaseToken"],
                "payload": data,
            },
            timeout=180,
        )
        heartbeat("ONLINE", None)
        log_event(f"결과 업로드 완료: 작업 {str(job.get('id'))[:8]}")
    except Exception as exc:
        log_event(f"수집 실패({time.time() - started:.0f}초 경과): 작업 {str(job.get('id'))[:8]} · {str(exc)[:300]}")
        exc.nrc_logged = True  # worker_loop가 같은 실패를 한 번 더 적지 않게 표시한다.
        try:
            _coordinator(
                "/worker/complete",
                {
                    "deviceId": device["id"],
                    "jobId": job["id"],
                    "leaseToken": job["leaseToken"],
                    "error": str(exc),
                },
            )
        finally:
            raise


def worker_loop():
    last_heartbeat = 0
    while True:
        try:
            if not worker_configuration().get("configured"):
                time.sleep(5)
                continue
            if time.time() - last_heartbeat > 15:
                active = heartbeat("ONLINE", None)
                if active:
                    enqueue_due_schedules()
                last_heartbeat = time.time()
            # Claiming a lease and finishing its upload are one update-protected unit.
            with ACTIVITY.activity():
                job = claim_job()
                if job:
                    log_event(f"작업 배정받음: 작업 {str(job.get('id'))[:8]} · 계정 {job.get('sourceAccountId')}")
                    try:
                        process_job(job)
                    except Exception as exc:
                        message = str(exc)
                        if not getattr(exc, "nrc_logged", False):
                            # 수집을 시작하기 전 단계(계정 불일치·등록 해제 등)의 실패
                            log_event(f"작업 처리 중단: {message[:300]}")
                        heartbeat("ERROR", message)
            if not job:
                time.sleep(5)
        except ReregisterNeeded:
            # 안내는 _access_token이 한 번만 남겼다. 사람이 다시 등록할 때까지 조용히 기다린다.
            time.sleep(30)
        except Exception as exc:
            # 네트워크가 끊긴 동안 같은 오류가 5초마다 쌓이지 않도록 줄인다.
            log_throttled("queue-error", f"Supabase 작업 대기열 오류: {exc}")
            time.sleep(10)
