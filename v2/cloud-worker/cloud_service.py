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
from account_recovery import SupabaseRecoveryStore, create_recovery_blueprint

import scraper as scraper_module
from scraper import run_combined


SUPABASE_URL = os.getenv("SUPABASE_URL", "https://ymagjzwebshfnjiisrao.supabase.co").rstrip("/")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
ENCRYPTION_KEY = os.getenv("NRC_CREDENTIAL_ENCRYPTION_KEY", "")
APP_ORIGIN = os.getenv("APP_ORIGIN", "https://prepaid1215.github.io")
CLOVA_OCR_SECRET_KEY = os.getenv("CLOVA_OCR_SECRET_KEY", "")
CLOVA_OCR_INVOKE_URL = os.getenv("CLOVA_OCR_INVOKE_URL", "")
WORKER_ID = os.getenv("WORKER_ID", f"cloud-{uuid.uuid4().hex[:8]}")
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "4"))
RUN_BROWSER_WORKER = os.getenv("RUN_BROWSER_WORKER", "false").lower() == "true"

app = Flask(__name__)
app.register_blueprint(create_recovery_blueprint(
    SupabaseRecoveryStore(SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY),
    SUPABASE_SERVICE_ROLE_KEY, APP_ORIGIN,
))
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


@app.route("/credentials/reveal", methods=["GET", "OPTIONS"])
def credentials_reveal():
    """이미 저장된 본인의 NRC 로그인정보를 복호화해 반환한다.
    로컬 NRC Sync 프로그램이 PC를 원클릭으로 자동 등록할 때만 쓰는 용도로,
    항상 요청자 본인(owner_id=본인)의 자격증명만 돌려준다."""
    if request.method == "OPTIONS":
        return "", 204
    try:
        user = user_from_request()
        owner_id = user["id"]
        rows = admin_request(
            f"nrc_cloud_credentials?owner_id=eq.{owner_id}&select=source_account_id,encrypted_credentials&order=updated_at.desc"
        ) or []
        result = []
        for row in rows:
            try:
                data = json.loads(cipher().decrypt(row["encrypted_credentials"].encode("ascii")))
                result.append({
                    "sourceAccountId": row["source_account_id"],
                    "loginId": data.get("loginId", row["source_account_id"]),
                    "password": data.get("password", ""),
                })
            except InvalidToken:
                continue
        return jsonify({"ok": True, "credentials": result})
    except PermissionError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 401
    except Exception as exc:
        return jsonify({"ok": False, "message": str(exc)}), 500


def is_app_admin(user_id):
    rows = admin_request(f"app_admins?user_id=eq.{user_id}&select=user_id") or []
    return bool(rows)


def _is_online(row):
    if row.get("revoked_at") or not row.get("collector_version"):
        return False
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
            "nrc_sync_devices?select=id,owner_id,device_name,status,last_seen_at,revoked_at,collector_version&order=last_seen_at.desc"
        ) or []
        admin = is_app_admin(user["id"])
        visible = rows if admin else [row for row in rows if row["owner_id"] == user["id"]]
        online = sum(1 for row in rows if _is_online(row))
        return jsonify({"ok": True, "devices": visible, "isAdmin": admin,
                        "summary": {"total": sum(not row.get("revoked_at") for row in rows), "online": online}})
    except PermissionError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 401
    except Exception as exc:
        return jsonify({"ok": False, "message": str(exc)}), 500


def owned_device(user_id, device_id, active=True):
    device_id = str(uuid.UUID(str(device_id)))
    suffix = "&revoked_at=is.null" if active else ""
    rows = admin_request(f"nrc_sync_devices?id=eq.{device_id}&owner_id=eq.{user_id}&select=*{suffix}") or []
    if not rows:
        raise PermissionError("등록되지 않았거나 등록 해제된 PC입니다.")
    return rows[0]


@app.route("/devices/<uuid:device_id>/registration", methods=["POST", "DELETE", "OPTIONS"])
def device_registration(device_id):
    if request.method == "OPTIONS":
        return "", 204
    try:
        user = user_from_request()
        rows = admin_request(f"nrc_sync_devices?id=eq.{device_id}&select=id,owner_id") or []
        if not rows:
            return jsonify(ok=False, message="PC를 찾을 수 없습니다."), 404
        if rows[0]["owner_id"] != user["id"] and not is_app_admin(user["id"]):
            return jsonify(ok=False, message="본인 PC 또는 관리자 권한이 필요합니다."), 403
        admin_request("rpc/set_pc_registration", "POST", {
            "p_actor":user["id"], "p_device":str(device_id), "p_enabled":request.method == "POST"})
        return jsonify(ok=True)
    except PermissionError as exc:
        return jsonify(ok=False, message=str(exc)), 401
    except Exception as exc:
        return jsonify(ok=False, message=str(exc)), 500


@app.route("/devices/register", methods=["POST", "OPTIONS"])
def register_pc():
    if request.method == "OPTIONS":
        return "", 204
    try:
        user = user_from_request()
        body = request.get_json(silent=True) or {}
        device_id = str(uuid.UUID(str(body.get("deviceId", ""))))
        rows = admin_request(f"nrc_sync_devices?id=eq.{device_id}&select=id,owner_id") or []
        if rows and rows[0]["owner_id"] != user["id"]:
            return jsonify(ok=False, message="다른 계정의 PC입니다."), 403
        if rows:
            admin_request("rpc/set_pc_registration", "POST", {"p_actor":user["id"], "p_device":device_id, "p_enabled":True})
        metadata = dict(owner_id=user["id"], device_name=str(body.get("deviceName", "PC"))[:100],
                        source_account_id=str(body.get("sourceAccountId", ""))[:100],
                        collector_version=str(body.get("collectorVersion", ""))[:80],
                        status="ONLINE", last_seen_at=datetime.now(timezone.utc).isoformat())
        if rows:
            admin_request(f"nrc_sync_devices?id=eq.{device_id}", "PATCH", metadata)
        else:
            admin_request("nrc_sync_devices", "POST", {"id":device_id, **metadata})
        return jsonify(ok=True)
    except PermissionError as exc:
        return jsonify(ok=False, message=str(exc)), 401
    except (ValueError, TypeError):
        return jsonify(ok=False, message="PC 정보가 올바르지 않습니다."), 400
    except Exception as exc:
        return jsonify(ok=False, message=str(exc)), 500


@app.route("/worker/heartbeat", methods=["POST", "OPTIONS"])
def pc_heartbeat():
    if request.method == "OPTIONS":
        return "", 204
    try:
        user = user_from_request()
        body = request.get_json(silent=True) or {}
        device = owned_device(user["id"], body.get("deviceId"), active=False)
        if device.get("revoked_at"):
            return jsonify(ok=True, revoked=True)
        status = body.get("status", "ONLINE")
        if status not in ("ONLINE", "BUSY", "OFFLINE", "ERROR"):
            return jsonify(ok=False, message="잘못된 PC 상태입니다."), 400
        # Conditional update cannot resurrect a device revoked between the read and write.
        admin_request(f"nrc_sync_devices?id=eq.{device['id']}&revoked_at=is.null", "PATCH", {
            "status":status, "last_seen_at":datetime.now(timezone.utc).isoformat(),
            "collector_version":str(body.get("collectorVersion", ""))[:80],
            "last_error":str(body.get("error") or "")[:1000] or None})
        return jsonify(ok=True, revoked=False)
    except PermissionError as exc:
        return jsonify(ok=False, message=str(exc)), 401
    except (ValueError, TypeError):
        return jsonify(ok=False, message="PC 정보가 올바르지 않습니다."), 400
    except Exception as exc:
        return jsonify(ok=False, message=str(exc)), 500


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


@app.route("/ocr/visit-form", methods=["POST", "OPTIONS"])
def ocr_visit_form():
    """센터방문 개통 요청서 이미지를 네이버 CLOVA OCR(General)로 인식해
    라벨-값 표를 줄 단위 텍스트로 재구성해 돌려준다. 프론트의 표 파서가
    그대로 재사용할 수 있게, CLOVA가 주는 lineBreak 힌트로 줄바꿈을 만든다."""
    if request.method == "OPTIONS":
        return "", 204
    try:
        user_from_request()
        if not (CLOVA_OCR_SECRET_KEY and CLOVA_OCR_INVOKE_URL):
            return jsonify({"ok": False, "message": "CLOVA OCR이 아직 설정되지 않았습니다."}), 503
        file = request.files.get("image")
        if not file:
            return jsonify({"ok": False, "message": "이미지 파일이 없습니다."}), 400
        image_bytes = file.read()
        if len(image_bytes) > 10 * 1024 * 1024:
            return jsonify({"ok": False, "message": "이미지 파일이 너무 큽니다(10MB 이하만 가능)."}), 400
        ext = (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ""
        image_format = ext if ext in ("jpg", "jpeg", "png", "pdf", "tiff") else "jpg"
        payload = {
            "version": "V2",
            "requestId": str(uuid.uuid4()),
            "timestamp": int(time.time() * 1000),
            "lang": "ko",
            "images": [
                {
                    "format": image_format,
                    "name": "visit-form",
                    "data": base64.b64encode(image_bytes).decode("ascii"),
                }
            ],
        }
        response = requests.post(
            CLOVA_OCR_INVOKE_URL,
            headers={"X-OCR-SECRET": CLOVA_OCR_SECRET_KEY, "Content-Type": "application/json"},
            json=payload,
            timeout=30,
        )
        if response.status_code != 200:
            return jsonify({"ok": False, "message": f"CLOVA OCR 요청 실패({response.status_code})"}), 502
        result = response.json()
        fields = (result.get("images") or [{}])[0].get("fields") or []
        lines, current = [], []
        for field in fields:
            current.append(str(field.get("inferText", "")))
            if field.get("lineBreak"):
                lines.append(" ".join(current))
                current = []
        if current:
            lines.append(" ".join(current))
        return jsonify({"ok": True, "text": "\n".join(lines)})
    except PermissionError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 401
    except Exception as exc:
        return jsonify({"ok": False, "message": str(exc)}), 500


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
        owned_device(user["id"], device_id)
        if body.get("lineMetricsVersion") != 2 or not body.get("collectorVersion"):
            return jsonify(ok=True, job=None, updateRequired=True)
        worker_id = pc_worker_id(user["id"], device_id)
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
        admin_request("rpc/start_pc_sync_job", "POST", {
            "p_actor":user["id"], "p_device":device_id, "p_job":job["id"]})
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
        device_id = str(uuid.UUID(str(body.get("deviceId", ""))))
        owned_device(user["id"], device_id)
        result = admin_request("rpc/complete_pc_sync_job", "POST", {
            "p_actor":user["id"], "p_device":device_id, "p_job":str(uuid.UUID(job_id)),
            "p_payload":body.get("payload") or {}, "p_error":str(body.get("error") or "").strip(),
        })
        return jsonify(result or {"ok":True})
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
