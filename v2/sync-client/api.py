"""
NRC 관리 앱 연동 API 서버
NRC관리 앱(prepaid1215.github.io/nr-manage)에서 이 로컬 API를 호출해서
nrcom.com 데이터를 가져갈 수 있습니다.

실행: python api.py
주소: http://localhost:5050
"""

import json
import hmac
import os
import time
import uuid
import threading
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from flask import Flask, Response, jsonify, request
from flask_cors import CORS
import keyring
import scraper as scraper_module
from scraper import run_daily, run_sales_now, run_closings, run_combined

app = Flask(__name__)
CORS(
    app,
    origins=["https://prepaid1215.github.io"],
    allow_headers=["Content-Type", "X-NRC-Sync-Token"],
    allow_private_network=True,
)
SYNC_TOKEN = os.getenv("NRC_SYNC_TOKEN", "")


@app.before_request
def require_sync_token():
    if request.method == "OPTIONS" or not request.path.startswith("/api/"):
        return None
    supplied = request.headers.get("X-NRC-Sync-Token", "")
    if not SYNC_TOKEN or not hmac.compare_digest(supplied, SYNC_TOKEN):
        return jsonify({"ok": False, "message": "내 컴퓨터 연결 코드가 맞지 않습니다."}), 401


DATA_DIR = Path(__file__).parent / "data"
sync_state = {"running": False, "completed": False, "error": None, "message": "대기 중"}
SCHEDULES_FILE = DATA_DIR / "sync_schedules.json"
KEYRING_SERVICE = "NRC-Management-Scheduler"
MANUAL_KEYRING_SERVICE = "NRC-Management-Manual"
SUPABASE_URL = "https://ymagjzwebshfnjiisrao.supabase.co"
SUPABASE_KEY = "sb_publishable_odxxHbBufV-ZSFlVJ8xFiw_18hBVyJf"


def load_schedules():
    if not SCHEDULES_FILE.exists():
        return []
    with open(SCHEDULES_FILE, encoding="utf-8") as handle:
        return json.load(handle)


def save_schedules(items):
    with open(SCHEDULES_FILE, "w", encoding="utf-8") as handle:
        json.dump(items, handle, ensure_ascii=False, indent=2)


def http_json(url, body, headers):
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def upload_snapshot(user_id, source_account_id, refresh_token):
    auth = http_json(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
        {"refresh_token": refresh_token},
        {"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
    )
    data = load_json("combined_latest.json")
    if not data:
        raise RuntimeError("업로드할 JSON이 없습니다.")
    http_json(
        f"{SUPABASE_URL}/rest/v1/nrc_sync_snapshots",
        {"owner_id": user_id, "source_account_id": source_account_id, "snapshot_type": "combined", "payload": data},
        {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {auth['access_token']}", "Content-Type": "application/json", "Prefer": "return=minimal"},
    )
    return auth.get("refresh_token", refresh_token)
def load_json(filename):
    path = DATA_DIR / filename
    if path.exists():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return None


# ─────────────────────────────────────────
# 1. 소비자 회선현황 (매일 자동 수집된 데이터)
# ─────────────────────────────────────────
@app.route("/api/consumers", methods=["GET"])
def get_consumers():
    data = load_json("consumer_lines.json")
    if data:
        return jsonify({"ok": True, "data": data})
    return jsonify({"ok": False, "message": "데이터 없음. 먼저 /api/sync/daily 를 호출하세요."}), 404


# ─────────────────────────────────────────
# 2. 본인매출내역 (즉시 수집)
# ─────────────────────────────────────────
@app.route("/api/sales", methods=["GET"])
def get_sales():
    """
    저장된 최신 매출 데이터 반환
    ?refresh=1 이면 즉시 nrcom에서 다시 수집
    """
    if request.args.get("refresh") == "1":
        period = request.args.get("period", "당월")
        def _run():
            run_sales_now(period)
        thread = threading.Thread(target=_run)
        thread.start()
        thread.join(timeout=60)

    data = load_json("sales_latest.json")
    if data:
        return jsonify({"ok": True, "data": data})
    return jsonify({"ok": False, "message": "데이터 없음. ?refresh=1 파라미터로 수집하세요."}), 404


# ─────────────────────────────────────────
# 3. 메인 실적 요약
# ─────────────────────────────────────────
@app.route("/api/stats", methods=["GET"])
def get_stats():
    data = load_json("main_stats.json")
    if data:
        return jsonify({"ok": True, "data": data})
    return jsonify({"ok": False, "message": "데이터 없음"}), 404


@app.route("/api/closings", methods=["GET"])
def get_closings():
    """월별 1~4차 마감 실적. ?year=2026&month=8&refresh=1"""
    now = datetime.now()
    year = request.args.get("year", now.year, type=int)
    month = request.args.get("month", now.month, type=int)
    filename = f"closings_{year:04d}_{month:02d}.json"
    if request.args.get("refresh") == "1":
        run_closings(year, month)
    data = load_json(filename)
    if data:
        return jsonify({"ok": True, "data": data})
    return jsonify({"ok": False, "message": "해당 월 마감 데이터 없음"}), 404


# ─────────────────────────────────────────
# 4. 수동 동기화 트리거
# ─────────────────────────────────────────
@app.route("/api/sync/daily", methods=["POST"])
def sync_daily():
    """소비자현황 + 실적요약 즉시 수집"""
    def _run():
        run_daily()
    thread = threading.Thread(target=_run)
    thread.start()
    return jsonify({"ok": True, "message": "백그라운드에서 수집 시작됨. /api/consumers 로 결과 확인 가능."})


@app.route("/api/sync/sales", methods=["POST"])
def sync_sales():
    """매출내역 즉시 수집"""
    period = request.json.get("period", "당월") if request.json else "당월"
    def _run():
        run_sales_now(period)
    thread = threading.Thread(target=_run)
    thread.start()
    return jsonify({"ok": True, "message": f"매출내역({period}) 수집 시작. /api/sales 로 결과 확인."})


@app.route("/api/sync/closings", methods=["POST"])
def sync_closings():
    body = request.json or {}
    now = datetime.now()
    year = int(body.get("year", now.year))
    month = int(body.get("month", now.month))
    thread = threading.Thread(target=run_closings, args=(year, month))
    thread.start()
    return jsonify({"ok": True, "message": f"{year}년 {month}월 마감차수 수집 시작"})


def start_combined_collection(body):
    """계보·NV·소비자회선 수집을 시작"""
    if sync_state["running"]:
        return True, "이미 수집 중입니다."

    app_user_id = str(body.get("appUserId", ""))
    login_id = str(body.get("loginId", "")).strip()
    password = str(body.get("password", ""))
    saved_text = keyring.get_password(MANUAL_KEYRING_SERVICE, app_user_id) if app_user_id else None
    if (not login_id or not password) and saved_text:
        saved = json.loads(saved_text)
        login_id = login_id or saved.get("loginId", "")
        password = password or saved.get("password", "")
    if len(login_id) < 3 or len(password) < 4:
        return False, "NRC 홈페이지 아이디와 비밀번호를 확인하세요."
    if body.get("remember") and app_user_id:
        keyring.set_password(MANUAL_KEYRING_SERVICE, app_user_id, json.dumps({"loginId": login_id, "password": password}))

    def _run():
        sync_state.update(running=True, completed=False, error=None, message="NRC 로그인 및 계보·NV·소비자회선 수집 중...")
        try:
            scraper_module.USER_ID = login_id
            scraper_module.USER_PW = password
            run_combined()
            sync_state.update(running=False, completed=True, message="계보·NV·소비자회선 수집 완료", source_account_id=login_id)
        except Exception as exc:
            sync_state.update(running=False, completed=False, error=str(exc), message="수집 실패")

    threading.Thread(target=_run, daemon=True).start()
    return True, "계보·NV·소비자회선 수집을 시작했습니다."


@app.route("/api/sync/combined", methods=["POST"])
def sync_combined():
    ok, message = start_combined_collection(request.json or {})
    return jsonify({"ok": ok, "message": message}), 200 if ok else 400


@app.route("/collect/start", methods=["POST"])
def collect_start_form():
    """브라우저 CORS를 거치지 않는 로컬 전용 수집 시작 폼"""
    origin = request.headers.get("Origin", "")
    supplied = request.form.get("syncToken", "")
    if origin != "https://prepaid1215.github.io" or not SYNC_TOKEN or not hmac.compare_digest(supplied, SYNC_TOKEN):
        return Response("연결 코드가 맞지 않습니다.", status=401, content_type="text/plain; charset=utf-8")
    ok, message = start_combined_collection(request.form)
    color = "#173b8f" if ok else "#c43d3d"
    html = f'''<!doctype html><meta charset="utf-8"><title>NRC Sync</title>
    <body style="font-family:sans-serif;padding:28px;color:{color}"><b>{message}</b>
    <script>setTimeout(() => window.close(), 700);</script></body>'''
    return Response(html, status=200 if ok else 400, content_type="text/html; charset=utf-8")


@app.route("/api/manual-credentials", methods=["GET", "DELETE"])
def manual_credentials():
    body = request.json or {} if request.method == "DELETE" else {}
    app_user_id = str(request.args.get("appUserId", "") if request.method == "GET" else body.get("appUserId", ""))
    if not app_user_id:
        return jsonify({"ok": False, "message": "앱 사용자 정보가 필요합니다."}), 400
    if request.method == "DELETE":
        try:
            keyring.delete_password(MANUAL_KEYRING_SERVICE, app_user_id)
        except keyring.errors.PasswordDeleteError:
            pass
        return jsonify({"ok": True})
    saved_text = keyring.get_password(MANUAL_KEYRING_SERVICE, app_user_id)
    if not saved_text:
        return jsonify({"ok": True, "saved": False})
    saved = json.loads(saved_text)
    return jsonify({"ok": True, "saved": True, "loginId": saved.get("loginId", "")})


def run_scheduled_collection(schedule_item):
    schedule_id = schedule_item["id"]
    secret_text = keyring.get_password(KEYRING_SERVICE, schedule_id)
    if not secret_text:
        raise RuntimeError("예약 계정의 자격 증명을 찾을 수 없습니다.")
    secret = json.loads(secret_text)
    sync_state.update(running=True, completed=False, error=None, message=f'{schedule_item["label"]} 예약 수집 중...')
    try:
        scraper_module.USER_ID = secret["loginId"]
        scraper_module.USER_PW = secret["password"]
        run_combined()
        rotated_token = upload_snapshot(secret["userId"], secret["loginId"], secret["refreshToken"])
        secret["refreshToken"] = rotated_token
        keyring.set_password(KEYRING_SERVICE, schedule_id, json.dumps(secret))
        status, error = "SUCCESS", None
        sync_state.update(running=False, completed=True, error=None, message=f'{schedule_item["label"]} 자동수집 및 업로드 완료', source_account_id=secret["loginId"])
    except Exception as exc:
        status, error = "ERROR", str(exc)
        sync_state.update(running=False, completed=False, error=error, message=f'{schedule_item["label"]} 자동수집 실패')
    items = load_schedules()
    for item in items:
        if item["id"] == schedule_id:
            item.update(last_run=datetime.now().isoformat(timespec="seconds"), last_status=status, last_error=error)
    save_schedules(items)


def scheduler_loop():
    while True:
        try:
            if not sync_state["running"]:
                now = datetime.now()
                today, current_time = now.date().isoformat(), now.strftime("%H:%M")
                for item in load_schedules():
                    last_day = str(item.get("last_run") or "")[:10]
                    if item.get("enabled", True) and last_day != today and current_time >= item["time"]:
                        threading.Thread(target=run_scheduled_collection, args=(item,), daemon=True).start()
                        break
        except Exception as exc:
            print(f"스케줄 확인 오류: {exc}")
        time.sleep(30)


@app.route("/api/schedules", methods=["GET", "POST", "DELETE"])
def schedules():
    items = load_schedules()
    if request.method == "GET":
        return jsonify({"ok": True, "schedules": items})
    body = request.json or {}
    if request.method == "DELETE":
        schedule_id = str(body.get("scheduleId", ""))
        try:
            keyring.delete_password(KEYRING_SERVICE, schedule_id)
        except keyring.errors.PasswordDeleteError:
            pass
        save_schedules([item for item in items if item["id"] != schedule_id])
        return jsonify({"ok": True})
    label = str(body.get("label", "")).strip()
    login_id = str(body.get("loginId", "")).strip()
    password = str(body.get("password", ""))
    run_time = str(body.get("time", ""))
    user_id = str(body.get("userId", ""))
    refresh_token = str(body.get("refreshToken", ""))
    if len(label) < 2 or len(login_id) < 3 or len(password) < 4 or len(run_time) != 5 or not user_id or not refresh_token:
        return jsonify({"ok": False, "message": "예약 이름, NRC 계정, 시간 정보를 확인하세요."}), 400
    schedule_id = uuid.uuid4().hex
    masked = "****" if len(login_id) <= 4 else f"{login_id[:2]}***{login_id[-2:]}"
    keyring.set_password(KEYRING_SERVICE, schedule_id, json.dumps({"loginId": login_id, "password": password, "userId": user_id, "refreshToken": refresh_token}))
    item = {"id": schedule_id, "label": label, "login_id_masked": masked, "time": run_time, "enabled": True, "last_run": None, "last_status": "WAITING", "last_error": None}
    items.append(item)
    save_schedules(items)
    return jsonify({"ok": True, "schedule": item})


@app.route("/api/combined", methods=["GET"])
def get_combined():
    data = load_json("combined_latest.json")
    if not data:
        return jsonify({"ok": False, "message": "수집된 10단계 데이터가 없습니다."}), 404
    collected_at = data.get("수집일시") or data.get("collectedAt")
    return jsonify({"ok": True, "data": data, "collected_at": collected_at})


# ─────────────────────────────────────────
# 5. 상태 확인
# ─────────────────────────────────────────
@app.route("/api/status", methods=["GET"])
def status():
    files = {}
    for name in ["consumer_lines.json", "sales_latest.json", "main_stats.json", "closings_latest.json"]:
        path = DATA_DIR / name
        if path.exists():
            data = load_json(name)
            files[name] = data.get("수집일시") if data else "파일 손상"
        else:
            files[name] = "없음"

    return jsonify({
        "ok": True,
        "server": "NRC Sync API",
        "version": "schedule-v1",
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "data_files": files,
        "sync": sync_state
    })


if __name__ == "__main__":
    print("🚀 NRC Sync API 서버 시작")
    print("📡 주소: http://localhost:5050")
    print()
    print("사용 가능한 엔드포인트:")
    print("  GET  /api/status          - 서버 상태 및 데이터 최신 수집일시")
    print("  GET  /api/consumers       - 소비자 회선현황")
    print("  GET  /api/sales           - 최신 매출내역")
    print("  GET  /api/sales?refresh=1 - 매출내역 즉시 수집 후 반환")
    print("  GET  /api/stats           - 메인 실적 요약")
    print("  POST /api/sync/daily      - 소비자현황+실적 즉시 수집")
    print("  POST /api/sync/sales      - 매출내역 즉시 수집")
    print()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    app.run(host="127.0.0.1", port=5050, debug=False)
