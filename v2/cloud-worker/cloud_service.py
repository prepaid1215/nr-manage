"""NRC 중앙 클라우드 Playwright 수집 서비스."""

import json
import base64
import hashlib
import hmac
import os
import shutil
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests
from cryptography.fernet import Fernet, InvalidToken
from flask import Flask, jsonify, request

import scraper as scraper_module
from scraper import run_combined


SUPABASE_URL = os.getenv("SUPABASE_URL", "https://ymagjzwebshfnjiisrao.supabase.co").rstrip("/")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
ENCRYPTION_KEY = os.getenv("NRC_CREDENTIAL_ENCRYPTION_KEY", "")
APP_ORIGIN = os.getenv("APP_ORIGIN", "https://prepaid1215.github.io")
WORKER_ID = os.getenv("WORKER_ID", f"cloud-{uuid.uuid4().hex[:8]}")
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "4"))
RUN_BROWSER_WORKER = os.getenv("RUN_BROWSER_WORKER", "false").lower() == "true"

app = Flask(__name__)
worker_state = {"running": False, "job_id": None, "message": "대기 중", "error": None}
_wake_event = threading.Event()
_worker_started = False


def configured():
    return bool(SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY and ENCRYPTION_KEY)


def cors(response):
    origin = request.headers.get("Origin", "")
    if origin == APP_ORIGIN:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return response


app.after_request(cors)


@app.route("/health", methods=["GET", "OPTIONS"])
def health():
    if request.method == "OPTIONS":
        return "", 204
    return jsonify({"ok": True, "configured": configured(), "worker": worker_state, "worker_id": WORKER_ID})


def user_from_request():
    authorization = request.headers.get("Authorization", "")
    if not authorization.startswith("Bearer "):
        raise PermissionError("앱 로그인이 필요합니다.")
    response = requests.get(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={"apikey": SUPABASE_ANON_KEY, "Authorization": authorization},
        timeout=20,
    )
    if response.status_code != 200:
        raise PermissionError("앱 로그인 세션이 만료되었습니다.")
    return response.json()


def admin_headers(prefer=None):
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def admin_request(path, method="GET", body=None, prefer=None):
    response = requests.request(
        method,
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers=admin_headers(prefer),
        json=body,
        timeout=60,
    )
    if response.status_code >= 300:
        raise RuntimeError(f"Supabase 요청 실패({response.status_code}): {response.text}")
    return response.json() if response.text else None


def user_rest_request(path):
    authorization = request.headers.get("Authorization", "")
    response = requests.get(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={"apikey": SUPABASE_ANON_KEY, "Authorization": authorization},
        timeout=20,
    )
    if response.status_code >= 300:
        raise RuntimeError(f"PC 등록 확인 실패({response.status_code}): {response.text}")
    return response.json() if response.text else None


def cipher():
    try:
        derived = base64.urlsafe_b64encode(hashlib.sha256(ENCRYPTION_KEY.encode("utf-8")).digest())
        return Fernet(derived)
    except Exception as exc:
        raise RuntimeError("클라우드 암호화 키 설정이 올바르지 않습니다.") from exc


@app.route("/credentials", methods=["GET", "POST", "DELETE", "OPTIONS"])
def credentials():
    if request.method == "OPTIONS":
        return "", 204
    try:
        user = user_from_request()
        owner_id = user["id"]
        if request.method == "GET":
            rows = admin_request(
                f"nrc_cloud_credentials?owner_id=eq.{owner_id}&select=source_account_id,updated_at&order=updated_at.desc"
            ) or []
            return jsonify({"ok": True, "credentials": rows})
        if request.method == "DELETE":
            source_account_id = request.args.get("sourceAccountId", "").strip()
            if not source_account_id:
                return jsonify({"ok": False, "message": "삭제할 NRC 계정을 지정하세요."}), 400
            admin_request(
                f"nrc_cloud_credentials?owner_id=eq.{owner_id}&source_account_id=eq.{source_account_id}",
                "DELETE",
            )
            return jsonify({"ok": True})
        body = request.get_json(silent=True) or {}
        login_id, password = str(body.get("loginId", "")).strip(), str(body.get("password", ""))
        if len(login_id) < 3 or len(password) < 4:
            return jsonify({"ok": False, "message": "NRC 홈페이지 아이디와 비밀번호를 확인하세요."}), 400
        encrypted = cipher().encrypt(
            json.dumps({"loginId": login_id, "password": password}).encode("utf-8")
        ).decode("ascii")
        admin_request(
            "nrc_cloud_credentials?on_conflict=owner_id,source_account_id",
            "POST",
            {"owner_id": owner_id, "source_account_id": login_id, "encrypted_credentials": encrypted, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            "resolution=merge-duplicates,return=minimal",
        )
        _wake_event.set()
        return jsonify({"ok": True, "sourceAccountId": login_id})
    except PermissionError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 401
    except Exception as exc:
        return jsonify({"ok": False, "message": str(exc)}), 500


def is_app_admin(user_id):
    rows = admin_request(f"app_admins?user_id=eq.{user_id}&select=user_id") or []
    return bool(rows)


def _is_online(row):
    if row.get("status") not in ("ONLINE", "BUSY"):
        return False
    try:
        seen = datetime.fromisoformat(str(row["last_seen_at"]).replace("Z", "+00:00"))
    except (KeyError, ValueError):
        return False
    return (datetime.now(timezone.utc) - seen).total_seconds() < 45


@app.route("/devices", methods=["GET", "OPTIONS"])
def devices():
    if request.method == "OPTIONS":
        return "", 204
    try:
        user = user_from_request()
        rows = admin_request(
            "nrc_sync_devices?select=device_name,status,last_seen_at&order=last_seen_at.desc"
        ) or []
        if is_app_admin(user["id"]):
            return jsonify({"ok": True, "devices": rows})
        # 관리자가 아니면 PC 이름 등 세부 정보 없이 전체/온라인 대수만 알려준다.
        online = sum(1 for row in rows if _is_online(row))
        return jsonify({"ok": True, "summary": {"total": len(rows), "online": online}})
    except PermissionError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 401
    except Exception as exc:
        return jsonify({"ok": False, "message": str(exc)}), 500


@app.route("/wake", methods=["POST", "OPTIONS"])
def wake():
    if request.method == "OPTIONS":
        return "", 204
    try:
        user_from_request()
        _wake_event.set()
        return jsonify({"ok": True})
    except PermissionError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 401


def patch_job(job_id, values):
    admin_request(
        f"nrc_sync_jobs?id=eq.{job_id}", "PATCH", {**values, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, "return=minimal"
    )


def claim_job():
    rows = admin_request("rpc/claim_cloud_sync_job", "POST", {"p_worker_id": WORKER_ID}) or []
    return rows[0] if rows else None


def load_credentials(owner_id, source_account_id):
    rows = admin_request(
        f"nrc_cloud_credentials?owner_id=eq.{owner_id}&source_account_id=eq.{source_account_id}&select=encrypted_credentials"
    ) or []
    if not rows:
        raise RuntimeError("클라우드에 저장된 NRC 로그인 정보가 없습니다.")
    try:
        return json.loads(cipher().decrypt(rows[0]["encrypted_credentials"].encode("ascii")))
    except InvalidToken as exc:
        raise RuntimeError("저장된 NRC 로그인 정보를 복호화할 수 없습니다.") from exc


def pc_worker_id(user_id, device_id):
    clean_device_id = str(device_id or "").strip()
    if len(clean_device_id) < 8:
        raise ValueError("PC 장치 정보가 올바르지 않습니다.")
    return f"pc-pool:{user_id}:{clean_device_id}"


def lease_token(job_id, worker_id):
    return hmac.new(
        ENCRYPTION_KEY.encode("utf-8"),
        f"{job_id}|{worker_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


@app.route("/worker/claim", methods=["POST", "OPTIONS"])
def worker_claim():
    if request.method == "OPTIONS":
        return "", 204
    try:
        user = user_from_request()
        body = request.get_json(silent=True) or {}
        device_id = str(body.get("deviceId", "")).strip()
        worker_id = pc_worker_id(user["id"], device_id)
        devices = user_rest_request(
            f"nrc_sync_devices?id=eq.{device_id}&owner_id=eq.{user['id']}&select=id"
        ) or []
        if not devices:
            raise PermissionError("이 앱 계정에 등록된 수집 PC가 아닙니다.")
        rows = admin_request(
            "rpc/claim_cloud_sync_job", "POST", {"p_worker_id": worker_id}
        ) or []
        if not rows:
            return jsonify({"ok": True, "job": None})
        job = rows[0]
        try:
            credentials = load_credentials(job["owner_id"], job["source_account_id"])
        except Exception as exc:
            patch_job(
                job["id"],
                {
                    "status": "ERROR",
                    "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "message": "공유 수집 승인정보 확인 실패",
                    "error": str(exc)[:4000],
                },
            )
            raise
        patch_job(
            job["id"],
            {
                "status": "RUNNING",
                "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "message": "승인된 Windows PC에서 수집 중...",
                "error": None,
            },
        )
        return jsonify(
            {
                "ok": True,
                "job": {
                    "id": job["id"],
                    "ownerId": job["owner_id"],
                    "sourceAccountId": job["source_account_id"],
                    "credentials": credentials,
                    "leaseToken": lease_token(job["id"], worker_id),
                },
            }
        )
    except PermissionError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 401
    except Exception as exc:
        return jsonify({"ok": False, "message": str(exc)}), 500


@app.route("/worker/complete", methods=["POST", "OPTIONS"])
def worker_complete():
    if request.method == "OPTIONS":
        return "", 204
    try:
        user = user_from_request()
        body = request.get_json(silent=True) or {}
        job_id = str(body.get("jobId", "")).strip()
        worker_id = pc_worker_id(user["id"], body.get("deviceId"))
        supplied_lease = str(body.get("leaseToken", ""))
        if not job_id or not hmac.compare_digest(
            supplied_lease, lease_token(job_id, worker_id)
        ):
            raise PermissionError("수집 작업 인증이 만료되었습니다.")
        rows = admin_request(
            f"nrc_sync_jobs?id=eq.{job_id}&select=id,owner_id,source_account_id,cloud_worker_id,status,snapshot_id"
        ) or []
        if not rows or rows[0].get("cloud_worker_id") != worker_id:
            raise PermissionError("이 PC에 배정된 작업이 아닙니다.")
        job = rows[0]
        if job.get("status") == "SUCCESS" and job.get("snapshot_id"):
            return jsonify({"ok": True, "alreadyCompleted": True})
        if job.get("status") != "RUNNING":
            raise PermissionError("이미 종료되었거나 유효하지 않은 수집 작업입니다.")
        error_message = str(body.get("error", "")).strip()
        if error_message:
            patch_job(
                job_id,
                {
                    "status": "ERROR",
                    "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "message": "Windows PC 수집 실패",
                    "error": error_message[:4000],
                },
            )
            return jsonify({"ok": True})
        data = body.get("payload") or {}
        collected_account = str(data.get("sourceAccountId") or "").strip()
        if collected_account != job["source_account_id"]:
            raise ValueError("요청 계정과 수집 결과 계정이 다릅니다.")
        snapshots = admin_request(
            "nrc_sync_snapshots",
            "POST",
            {
                "owner_id": job["owner_id"],
                "source_account_id": collected_account,
                "snapshot_type": "combined",
                "payload": data,
                "collected_at": data.get("수집일시")
                or data.get("collectedAt")
                or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            "return=representation",
        )
        patch_job(
            job_id,
            {
                "status": "SUCCESS",
                "snapshot_id": snapshots[0]["id"],
                "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "message": "승인된 Windows PC 수집 완료",
                "error": None,
            },
        )
        return jsonify({"ok": True})
    except PermissionError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 401
    except Exception as exc:
        return jsonify({"ok": False, "message": str(exc)}), 500


def process_job(job):
    credentials = load_credentials(job["owner_id"], job["source_account_id"])
    temp_dir = Path(tempfile.mkdtemp(prefix="nrc-cloud-"))
    worker_state.update(running=True, job_id=job["id"], message="NRC 클라우드 수집 중...", error=None)
    patch_job(job["id"], {"status": "RUNNING", "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "message": "클라우드 Playwright 수집 중...", "error": None})
    try:
        scraper_module.DATA_DIR = temp_dir
        scraper_module.USER_ID = credentials["loginId"]
        scraper_module.USER_PW = credentials["password"]
        run_combined()
        data = json.loads((temp_dir / "combined_latest.json").read_text(encoding="utf-8"))
        collected_account = str(data.get("sourceAccountId") or credentials["loginId"]).strip()
        if collected_account != credentials["loginId"]:
            raise RuntimeError(f"요청 계정과 수집 계정이 달라 저장을 중단했습니다: {collected_account}")
        snapshots = admin_request(
            "nrc_sync_snapshots",
            "POST",
            {"owner_id": job["owner_id"], "source_account_id": collected_account, "snapshot_type": "combined", "payload": data, "collected_at": data.get("수집일시") or data.get("collectedAt")},
            "return=representation",
        )
        patch_job(job["id"], {"status": "SUCCESS", "snapshot_id": snapshots[0]["id"], "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "message": "클라우드 수집 완료", "error": None})
        worker_state.update(running=False, job_id=None, message="최근 수집 완료", error=None)
    except Exception as exc:
        message = str(exc)
        patch_job(job["id"], {"status": "ERROR", "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "message": "클라우드 수집 실패", "error": message})
        worker_state.update(running=False, job_id=None, message="최근 수집 실패", error=message)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def worker_loop():
    while True:
        try:
            if not configured():
                time.sleep(10)
                continue
            admin_request("rpc/enqueue_due_cloud_schedules", "POST", {})
            if RUN_BROWSER_WORKER:
                job = claim_job()
                if job:
                    process_job(job)
                    continue
            else:
                worker_state.update(
                    running=False,
                    job_id=None,
                    message="승인된 Windows PC에 수집 작업 배정 중",
                    error=None,
                )
        except Exception as exc:
            worker_state.update(running=False, message="클라우드 작업 확인 오류", error=str(exc))
        _wake_event.wait(POLL_SECONDS)
        _wake_event.clear()


def start_worker():
    global _worker_started
    if not _worker_started:
        threading.Thread(target=worker_loop, daemon=True).start()
        _worker_started = True


start_worker()
