"""
NRC 관리 앱 연동 API 서버
NRC관리 앱(prepaid1215.github.io/nr-manage)에서 이 로컬 API를 호출해서
nrcom.com 데이터를 가져갈 수 있습니다.

실행: python api.py
주소: http://localhost:5050
"""

import json
import hmac
import html
import os
import shutil
import subprocess
import sys
import time
import uuid
import threading
import webbrowser
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from flask import Flask, Response, jsonify, request
from flask_cors import CORS
import keyring
import scraper as scraper_module
from scraper import run_daily, run_sales_now, run_closings, run_combined
from queue_worker import configure_worker, configure_worker_from_session, worker_configuration, worker_loop, deregister_device
from runtime_mode import TEMP_MODE

if getattr(sys, "frozen", False) and (sys.stdout is None or not hasattr(sys.stdout, "write")):
    # --windowed 빌드는 콘솔이 없어 sys.stdout/stderr가 None이라 print()가 죽는다.
    # 로그 파일로 대신 보내서 기존 print() 호출들이 계속 동작하게 한다.
    _log_dir = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "NRCSync"
    _log_dir.mkdir(parents=True, exist_ok=True)
    _log_file = open(_log_dir / "nrcsync.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = _log_file
    sys.stderr = _log_file

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


DATA_DIR = (
    Path(tempfile.mkdtemp(prefix="NRCSync-Temp-"))
    if TEMP_MODE
    else (
        Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "NRCSync" / "data"
        if getattr(sys, "frozen", False)
        else Path(__file__).parent / "data"
    )
)
# 크로미움 설치 여부 표시는 임시 모드에서도 재설치를 반복하지 않도록 항상 고정 경로를 쓴다.
CHROMIUM_MARKER_DIR = (
    Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "NRCSync" / "data"
    if getattr(sys, "frozen", False)
    else DATA_DIR
)
sync_state = {"running": False, "completed": False, "error": None, "message": "대기 중"}
SCHEDULES_FILE = DATA_DIR / "sync_schedules.json"
KEYRING_SERVICE = "NRC-Management-Scheduler"
MANUAL_KEYRING_SERVICE = "NRC-Management-Manual"
SUPABASE_URL = "https://ymagjzwebshfnjiisrao.supabase.co"
SUPABASE_KEY = "sb_publishable_odxxHbBufV-ZSFlVJ8xFiw_18hBVyJf"


def setup_page(message="", error=False):
    configured = worker_configuration()
    current_name = html.escape(str(configured.get("device_name", "")))
    current_nrc = html.escape(str(configured.get("source_account_id", "")))
    notice = ""
    if message:
        color = "#b42318" if error else "#176b4d"
        notice = f'<div style="padding:12px;border-radius:12px;background:#f5f3ff;color:{color};margin-bottom:16px">{html.escape(message)}</div>'
    return f'''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>NRC Sync PC 등록</title><style>
    body{{font-family:system-ui,sans-serif;background:#f6f5ff;margin:0;padding:24px;color:#202038}}
    main{{max-width:560px;margin:24px auto;background:white;padding:28px;border-radius:24px;box-shadow:0 18px 50px #5048a51f}}
    h1{{color:#5b55b9}}p{{color:#6e7191;line-height:1.55}}label{{display:block;margin:15px 0 6px}}
    input{{box-sizing:border-box;width:100%;padding:13px;border:1px solid #d8d8ea;border-radius:12px;font-size:16px}}
    button{{width:100%;margin-top:22px;padding:14px;border:0;border-radius:13px;background:#655cc8;color:white;font-weight:700;font-size:16px}}
    small{{display:block;margin-top:16px;color:#8386a3;line-height:1.5}}</style>
    <main><h1>NRC Sync PC 등록</h1><p>이 PC를 앱 계정에 한 번 등록하면 연결 코드 없이 어디서든 수집을 요청할 수 있습니다.</p>{notice}
    <form method="post" action="/setup/save">
    <label>이 PC 이름</label><input name="deviceName" value="{current_name}" placeholder="예: 사무실 PC" required>
    <label>관리 앱 아이디</label><input name="appUsername" autocomplete="username" required>
    <label>관리 앱 비밀번호</label><input name="appPassword" type="password" autocomplete="current-password" required>
    <label>NRC 홈페이지 아이디</label><input name="nrcLoginId" value="{current_nrc}" autocomplete="username" required>
    <label>NRC 홈페이지 비밀번호</label><input name="nrcPassword" type="password" autocomplete="current-password" required>
    <button type="submit">이 PC 등록하기</button></form>
    <small>NRC 비밀번호는 Supabase로 전송하지 않고 이 PC의 Windows 자격 증명 저장소에만 보관됩니다.</small></main></html>'''


@app.route("/setup", methods=["GET"])
def worker_setup_page():
    configured = worker_configuration()
    message = "이 PC가 이미 등록되어 있습니다. 다시 저장하면 계정 정보를 갱신합니다." if configured.get("configured") else ""
    return Response(setup_page(message), content_type="text/html; charset=utf-8")


@app.route("/setup/save", methods=["POST"])
def worker_setup_save():
    try:
        device = configure_worker(
            request.form.get("appUsername", ""),
            request.form.get("appPassword", ""),
            request.form.get("nrcLoginId", ""),
            request.form.get("nrcPassword", ""),
            request.form.get("deviceName", ""),
        )
        return Response(
            setup_page(f"{device['device_name']} 등록 완료. 이제 이 창을 닫아도 됩니다."),
            content_type="text/html; charset=utf-8",
        )
    except Exception as exc:
        return Response(setup_page(str(exc), True), status=400, content_type="text/html; charset=utf-8")


@app.route("/register-device-auto", methods=["POST", "OPTIONS"])
def register_device_auto():
    """웹 앱에 이미 로그인된 세션을 그대로 받아 입력창 없이 이 PC를 등록한다."""
    if request.method == "OPTIONS":
        return "", 204
    body = request.get_json(silent=True) or {}
    try:
        device = configure_worker_from_session(
            body.get("accessToken", ""),
            body.get("refreshToken", ""),
            body.get("deviceName") or None,
            body.get("expiresIn"),
        )
        return jsonify({"ok": True, "device": device})
    except Exception as exc:
        return jsonify({"ok": False, "message": str(exc)}), 400


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
    allowed_origins = {"", "null", "https://prepaid1215.github.io"}
    if origin not in allowed_origins or not SYNC_TOKEN or not hmac.compare_digest(supplied, SYNC_TOKEN):
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


def install_dir():
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "NRCSync"


def startup_vbs_path():
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    return (
        Path(appdata)
        / "Microsoft"
        / "Windows"
        / "Start Menu"
        / "Programs"
        / "Startup"
        / "NRCSync.vbs"
    )


def ensure_startup_registered(target_exe):
    """Windows 로그인 시 자동 실행되도록 등록되어 있는지 매번 확인하고,
    빠져 있으면(사람이 지웠거나, 예전 버전이 등록을 안 했거나) 다시 만든다.
    이미 올바르게 등록돼 있으면 아무 것도 다시 쓰지 않는다."""
    startup_path = startup_vbs_path()
    if not startup_path:
        return
    # VBScript는 문자열 안의 큰따옴표를 ""(두 번)로 이스케이프한다.
    # \" 같은 백슬래시 이스케이프는 VBScript에 없어서 구문 오류가 난다.
    expected = (
        'Set shell = CreateObject("WScript.Shell")\r\n'
        f'shell.Run """{target_exe}""", 0, False\r\n'
    )
    try:
        if startup_path.exists() and startup_path.read_text(encoding="utf-8") == expected:
            return
        startup_path.parent.mkdir(parents=True, exist_ok=True)
        startup_path.write_text(expected, encoding="utf-8")
        print("✅ Windows 로그인 시 자동 실행되도록 등록했습니다.")
    except Exception as exc:
        print(f"⚠️ 자동 실행 등록 실패(수동 실행은 계속 가능): {exc}")


def self_install_and_relaunch():
    """설치 위치가 아닌 곳(다운로드 폴더 등)에서 처음 실행되면, 설치 위치로
    스스로를 복사한 뒤 설치된 위치에서 다시 실행한다. 이미 설치 위치에서
    실행 중이면 복사 없이 자동 실행 등록만 확인한다. python api.py로 직접
    실행할 때는 해당 없음(frozen 아님)."""
    if not getattr(sys, "frozen", False) or TEMP_MODE:
        return False
    current_exe = Path(sys.executable).resolve()
    target_exe = install_dir() / "NRCSync.exe"
    if target_exe.exists() and current_exe == target_exe.resolve():
        ensure_startup_registered(target_exe)
        return False

    print("🧩 처음 실행되었습니다. NRC Sync를 설치합니다...")
    target_exe.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copy2(current_exe, target_exe)
    except shutil.SameFileError:
        pass

    ensure_startup_registered(target_exe)

    print(f"✅ 설치 완료: {target_exe}")
    subprocess.Popen([str(target_exe)], cwd=str(target_exe.parent))
    return True


def ensure_chromium_installed():
    """설치 파일로 처음 실행될 때 Playwright 브라우저를 한 번 자동 설치한다."""
    marker = CHROMIUM_MARKER_DIR / ".chromium_installed"
    if marker.exists():
        return
    CHROMIUM_MARKER_DIR.mkdir(parents=True, exist_ok=True)
    print("🧩 처음 실행 중입니다. NRC 수집용 브라우저를 설치합니다 (1~2분 소요)...")
    try:
        python_exe = sys.executable
        args = (
            [python_exe, "-m", "playwright", "install", "chromium"]
            if not getattr(sys, "frozen", False)
            else [python_exe, "--playwright-install"]
        )
        subprocess.run(args, check=True)
        marker.write_text("ok", encoding="utf-8")
        print("✅ 브라우저 설치 완료.")
    except Exception as exc:
        print(f"⚠️ 브라우저 자동 설치 실패, 수동으로 설치가 필요할 수 있습니다: {exc}")


APP_URL = "https://prepaid1215.github.io/nr-manage/v2/frontend/"


def open_setup_page_if_needed():
    def _open():
        if TEMP_MODE:
            # 임시 연결 모드는 부팅 자동실행이 아니라 방금 사람이 직접 켠 것이므로
            # DPAPI 대기 없이 바로 확인하고, 로컬 등록폼 대신 이미 로그인돼 있을
            # 웹 앱을 열어 '이 PC 자동 등록' 버튼으로 이어지게 한다.
            time.sleep(1.5)
            if worker_configuration().get("configured"):
                return
            try:
                webbrowser.open(APP_URL)
            except Exception:
                pass
            return
        # Windows 로그인 직후에는 자격 증명 저장소(DPAPI)가 아직 준비되지 않아
        # keyring 조회가 일시적으로 실패할 수 있다. 즉시 판단하지 않고
        # 여유를 두고 여러 번 재확인한 뒤에도 미등록이면 그때 설정 화면을 연다.
        for attempt in range(5):
            time.sleep(3 if attempt == 0 else 5)
            if worker_configuration().get("configured"):
                return
        try:
            webbrowser.open("http://127.0.0.1:5050/setup")
        except Exception:
            pass

    threading.Thread(target=_open, daemon=True).start()


def _tray_icon_image():
    from PIL import Image

    candidates = []
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys._MEIPASS) / "app_icon.ico")
    candidates.append(Path(__file__).parent / "app_icon.ico")
    for candidate in candidates:
        if candidate.exists():
            return Image.open(candidate)
    image = Image.new("RGB", (64, 64), "#173b8f")
    return image


def run_with_tray():
    """트레이 아이콘이 되면 트레이로, 안 되면(라이브러리 없음 등) 콘솔 모드로 그냥 서버만 켠다."""
    try:
        import pystray
    except Exception:
        app.run(host="127.0.0.1", port=5050, debug=False, use_reloader=False)
        return

    server_thread = threading.Thread(
        target=lambda: app.run(
            host="127.0.0.1", port=5050, debug=False, use_reloader=False
        ),
        daemon=True,
    )
    server_thread.start()

    def open_setup(icon_obj=None, item=None):
        webbrowser.open(APP_URL if TEMP_MODE else "http://127.0.0.1:5050/setup")

    def quit_app(icon_obj=None, item=None):
        if TEMP_MODE:
            # 임시 연결 모드는 끄는 순간 서버 쪽 PC 등록도 같이 지워서 흔적을 안 남긴다.
            deregister_device()
        icon_obj.stop()
        os._exit(0)

    menu_label = "이 PC 연결(임시)" if TEMP_MODE else "설정 열기"
    quit_label = "연결 끊기" if TEMP_MODE else "종료"
    menu = pystray.Menu(
        pystray.MenuItem(menu_label, open_setup, default=True),
        pystray.MenuItem(quit_label, quit_app),
    )
    tooltip = "NRC Sync 임시 연결 중" if TEMP_MODE else "NRC Sync 실행 중"
    icon = pystray.Icon("NRCSync", _tray_icon_image(), tooltip, menu)
    icon.run()


if __name__ == "__main__":
    if "--playwright-install" in sys.argv:
        from playwright.__main__ import main as playwright_main

        sys.argv = ["playwright", "install", "chromium"]
        playwright_main()
        sys.exit(0)

    if self_install_and_relaunch():
        sys.exit(0)

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
    ensure_chromium_installed()
    open_setup_page_if_needed()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    threading.Thread(target=worker_loop, daemon=True).start()
    run_with_tray()
