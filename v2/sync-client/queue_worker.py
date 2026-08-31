"""Supabase 작업 대기열을 소비하는 다중 PC NRC 수집기."""

import json
import os
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


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def _json_request(url, method="GET", body=None, headers=None, timeout=60):
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
            except json.JSONDecodeError:
                message = detail
            raise RuntimeError(f"서버 요청 실패({exc.code}): {message}") from exc
        except urllib.error.URLError as exc:
            if getattr(exc.reason, "winerror", None) == 10013 and attempt < 2:
                time.sleep(attempt + 1)
                continue
            raise RuntimeError(f"서버 연결 실패: {exc.reason}") from exc


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
        _cached_auth.clear()
        _cached_auth.update(
            accessToken=access_token,
            expiresAt=time.time() + int(expires_in or 3600) - 60,
            userId=user_id,
        )
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
        saved = json.loads(saved_text)
        auth = _json_request(
            f"{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
            method="POST",
            body={"refresh_token": saved["refreshToken"]},
            headers={"apikey": SUPABASE_KEY},
        )
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
    _rest(
        "nrc_sync_devices?on_conflict=id",
        "POST",
        {
            "id": device["id"],
            "owner_id": device["owner_id"],
            "device_name": device["device_name"],
            "source_account_id": device["source_account_id"],
            "status": status,
            "last_seen_at": utc_now(),
            "last_error": error,
            "updated_at": utc_now(),
        },
        "resolution=merge-duplicates,return=minimal",
    )


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
    result = _coordinator("/worker/claim", {"deviceId": device["id"]}) or {}
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


def process_job(job):
    device = _load_device()
    credentials = job.get("credentials") or {}
    login_id = credentials["loginId"]
    requested_account = str(job.get("sourceAccountId") or "").strip()
    if requested_account and requested_account != login_id:
        raise RuntimeError("배정된 NRC 계정 정보가 일치하지 않습니다.")

    heartbeat("BUSY", None)
    try:
        (DATA_DIR / "combined_latest.json").unlink(missing_ok=True)
        scraper_module.USER_ID = login_id
        scraper_module.USER_PW = credentials["password"]
        run_combined()
        data = _load_combined()
        collected_account = str(data.get("sourceAccountId") or login_id).strip()
        if collected_account != login_id:
            raise RuntimeError(
                f"요청 계정({login_id})과 수집 계정({collected_account})이 다릅니다."
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
    except Exception as exc:
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
                heartbeat("ONLINE", None)
                enqueue_due_schedules()
                last_heartbeat = time.time()
            job = claim_job()
            if not job:
                time.sleep(5)
                continue
            try:
                process_job(job)
            except Exception as exc:
                message = str(exc)
                heartbeat("ERROR", message)
        except Exception as exc:
            print(f"Supabase 작업 대기열 오류: {exc}")
            time.sleep(10)
