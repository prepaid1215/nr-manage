"""Supabase 작업 대기열을 소비하는 다중 PC NRC 수집기."""

import json
import os
import socket
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
DATA_DIR = Path(__file__).parent / "data"
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
        raise RuntimeError(f"Supabase 요청 실패({exc.code}): {message}") from exc


def _load_device():
    if not DEVICE_FILE.exists():
        return None
    return json.loads(DEVICE_FILE.read_text(encoding="utf-8"))


def _save_device(device):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DEVICE_FILE.write_text(json.dumps(device, ensure_ascii=False, indent=2), encoding="utf-8")


def _session_key(device_id):
    return f"device:{device_id}"


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
    user_id = auth["user"]["id"]
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
        json.dumps({"userId": user_id, "refreshToken": auth["refresh_token"]}),
    )
    keyring.set_password(
        CREDENTIAL_SERVICE,
        user_id,
        json.dumps({"loginId": nrc_login_id, "password": nrc_password}),
    )
    with _auth_lock:
        _cached_auth.clear()
        _cached_auth.update(
            accessToken=auth["access_token"],
            expiresAt=time.time() + int(auth.get("expires_in", 3600)) - 60,
            userId=user_id,
        )
    heartbeat("ONLINE", None)
    return device


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
    rows = _rest("rpc/claim_nrc_sync_job", "POST", {"p_device_id": device["id"]}) or []
    return rows[0] if rows else None


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
    credentials_text = keyring.get_password(CREDENTIAL_SERVICE, device["owner_id"])
    if not credentials_text:
        raise RuntimeError("이 PC에 저장된 NRC 로그인 정보가 없습니다. NRC Sync 설정을 다시 해주세요.")
    credentials = json.loads(credentials_text)
    login_id = credentials["loginId"]
    requested_account = str(job.get("source_account_id") or "").strip()
    if requested_account and requested_account != login_id:
        raise RuntimeError(f"이 PC는 NRC 계정 {login_id}용으로 등록되어 있습니다.")

    _patch_job(
        job["id"],
        {"status": "RUNNING", "started_at": utc_now(), "message": f"{device['device_name']}에서 수집 중...", "error": None},
    )
    heartbeat("BUSY", None)
    scraper_module.USER_ID = login_id
    scraper_module.USER_PW = credentials["password"]
    run_combined()
    data = _load_combined()
    collected_account = str(data.get("sourceAccountId") or login_id).strip()
    if collected_account != login_id:
        raise RuntimeError(f"요청 계정({login_id})과 수집 계정({collected_account})이 다릅니다.")

    snapshots = _rest(
        "nrc_sync_snapshots",
        "POST",
        {
            "owner_id": device["owner_id"],
            "source_account_id": login_id,
            "snapshot_type": "combined",
            "payload": data,
            "collected_at": data.get("수집일시") or data.get("collectedAt") or utc_now(),
        },
        "return=representation",
    )
    snapshot_id = snapshots[0]["id"]
    _patch_job(
        job["id"],
        {
            "status": "SUCCESS",
            "snapshot_id": snapshot_id,
            "completed_at": utc_now(),
            "message": "매출·계보·소비자회선 수집 완료",
            "error": None,
        },
    )
    heartbeat("ONLINE", None)


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
                _patch_job(
                    job["id"],
                    {"status": "ERROR", "completed_at": utc_now(), "message": "수집 실패", "error": message},
                )
                heartbeat("ERROR", message)
        except Exception as exc:
            print(f"Supabase 작업 대기열 오류: {exc}")
            time.sleep(10)
