"""Account recovery. Answers and temporary passwords never enter logs or user metadata."""

import hashlib
import hmac
import re
import secrets
import unicodedata
from datetime import datetime, timezone
from urllib.parse import urlencode

import requests
from flask import Blueprint, jsonify, request


QUESTIONS = {
    "secret_word": "나만 아는 비밀 단어는?",
    "memory_place": "나만 기억하는 특별한 장소는?",
    "nickname": "나만 알고 있는 별명은?",
}
MISMATCH = "입력한 정보나 퀴즈 답이 일치하지 않습니다. 퀴즈를 등록하지 않았다면 관리자에게 초기화를 요청하세요."


class RecoveryError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def normalize_answer(value):
    return " ".join(unicodedata.normalize("NFKC", value).strip().casefold().split())


def answer_hash(answer, salt):
    return hashlib.scrypt(normalize_answer(answer).encode(), salt=bytes.fromhex(salt),
                          n=16384, r=8, p=1, dklen=32).hex()


def validate_quiz(body):
    question, answer = body.get("question"), body.get("answer")
    if not isinstance(question, str) or question not in QUESTIONS or not isinstance(answer, str) or not 2 <= len(normalize_answer(answer)) <= 128:
        raise RecoveryError("질문을 선택하고 답을 2~128자로 입력하세요.")
    return question, answer


def validate_password(value):
    if not isinstance(value, str) or len(value) < 8 or len(value.encode()) > 72:
        raise RecoveryError("새 비밀번호는 8자 이상, 영문 기준 72자 이내로 입력하세요.")
    return value


class SupabaseRecoveryStore:
    def __init__(self, url, anon_key, service_key):
        self.url, self.anon_key, self.service_key = url, anon_key, service_key

    def call(self, path, method="GET", body=None, token=None, prefer=None):
        headers = {"apikey": self.service_key, "Authorization": f"Bearer {token or self.service_key}"}
        if prefer:
            headers["Prefer"] = prefer
        response = requests.request(method, self.url + path, headers=headers, json=body, timeout=25)
        if response.status_code >= 400:
            # Never propagate GoTrue/PostgREST response bodies: they may contain account information.
            if response.status_code in (400, 422) and path.startswith("/auth/v1/admin/users/"):
                raise RecoveryError("비밀번호가 서버의 보안 조건에 맞지 않습니다. 다른 비밀번호로 다시 시도하세요.")
            raise RecoveryError("계정 복구 서비스를 사용할 수 없습니다. 잠시 후 다시 시도하세요.", 503)
        return response.json() if response.content else None

    def rows(self, table, **filters):
        return self.call("/rest/v1/" + table + "?" + urlencode(filters)) or []

    def user(self, token):
        response = requests.get(self.url + "/auth/v1/user", headers={
            "apikey": self.anon_key, "Authorization": f"Bearer {token}"}, timeout=25)
        if response.status_code != 200:
            raise RecoveryError("다시 로그인해 주세요.", 401)
        return response.json()

    def confirm_password(self, user, password):
        if not isinstance(password, str) or not 1 <= len(password) <= 128:
            raise RecoveryError("현재 비밀번호를 입력하세요.")
        response = requests.post(self.url + "/auth/v1/token?grant_type=password", headers={
            "apikey": self.anon_key}, json={"email": user["email"], "password": password}, timeout=25)
        data = response.json()
        if response.status_code != 200 or data.get("user", {}).get("id") != user["id"]:
            raise RecoveryError("현재 비밀번호가 일치하지 않습니다.", 403)
        # A password check must not leave another refreshable session behind.
        self.call("/auth/v1/logout?scope=local", "POST", token=data["access_token"])

    def profile(self, **filters):
        filters.update(select="id,username,member_no,name,status", limit="1")
        rows = self.rows("profiles", **filters)
        return rows[0] if rows else None

    def quiz(self, user_id):
        rows = self.rows("account_recovery_quizzes", user_id=f"eq.{user_id}", select="question,answer_salt,answer_hash")
        return rows[0] if rows else None

    def save_quiz(self, user_id, question, answer):
        salt = secrets.token_hex(16)
        self.call("/rest/v1/account_recovery_quizzes?on_conflict=user_id", "POST", {
            "user_id": user_id, "question": question, "answer_salt": salt,
            "answer_hash": answer_hash(answer, salt), "updated_at": datetime.now(timezone.utc).isoformat(),
        }, prefer="resolution=merge-duplicates")

    def allowed(self, account_key, client_key):
        return self.call("/rest/v1/rpc/consume_account_recovery_attempt", "POST", {
            "p_account_key": account_key, "p_client_key": client_key}) is True

    def is_admin(self, user_id):
        return bool(self.rows("app_admins", user_id=f"eq.{user_id}", select="user_id"))

    def update_password(self, user_id, password, temporary=False):
        self.call("/auth/v1/admin/users/" + user_id, "PUT", {
            "password": password, "app_metadata": {"recovery_password_required": temporary}})

    def audit(self, actor_id, target_id, result):
        self.call("/rest/v1/audit_logs", "POST", {"actor_id": actor_id,
            "action": "admin_password_reset", "target_type": "account", "target_id": target_id,
            "result": result, "detail": {}})


def create_recovery_blueprint(store, secret, origin):
    bp = Blueprint("account_recovery", __name__, url_prefix="/account-recovery")

    @bp.before_request
    def validate_request():
        if request.headers.get("Origin") not in (None, origin):
            raise RecoveryError("허용되지 않은 요청입니다.", 403)
        if request.content_length and request.content_length > 8192:
            raise RecoveryError("입력 내용이 너무 깁니다.", 413)
        if not secret:
            raise RecoveryError("계정 복구 서비스 설정이 필요합니다.", 503)

    @bp.after_request
    def no_cache(response):
        response.headers["Cache-Control"] = "no-store"
        return response

    @bp.errorhandler(RecoveryError)
    def handle_error(error):
        response = jsonify(ok=False, message=str(error))
        response.status_code = error.status
        if error.status == 429:
            response.headers["Retry-After"] = "900"
        return response

    @bp.errorhandler(Exception)
    def service_error(_error):
        return jsonify(ok=False, message="계정 복구 서비스를 사용할 수 없습니다. 잠시 후 다시 시도하세요."), 503

    def body():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise RecoveryError("입력 내용을 확인하세요.")
        return data

    def current_user():
        authorization = request.headers.get("Authorization", "")
        if not authorization.startswith("Bearer ") or not authorization[7:]:
            raise RecoveryError("로그인이 필요합니다.", 401)
        user = store.user(authorization[7:])
        profile = store.profile(id=f"eq.{user['id']}")
        if not profile or profile["status"] != "ACTIVE":
            raise RecoveryError("이 계정에서는 요청할 수 없습니다.", 403)
        return user, authorization[7:]

    def limit(account):
        def key(value):
            return hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()
        # Render's final proxy appends its observed client address. Do not trust the first forwarded value.
        client = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[-1].strip()
        if not store.allowed(key(account), key(client)):
            raise RecoveryError("시도 횟수를 초과했습니다. 15분 후 다시 시도하세요.", 429)

    @bp.route("/quiz", methods=["GET", "POST"])
    def quiz():
        user, _ = current_user()
        if user.get("app_metadata", {}).get("recovery_password_required"):
            raise RecoveryError("먼저 임시 비밀번호를 변경하세요.", 403)
        if request.method == "GET":
            saved = store.quiz(user["id"])
            return jsonify(ok=True, configured=bool(saved), question=saved["question"] if saved else None)
        data = body()
        question, answer = validate_quiz(data)
        limit("setup:" + user["id"])
        store.confirm_password(user, data.get("currentPassword"))
        store.save_quiz(user["id"], question, answer)
        return jsonify(ok=True)

    @bp.post("/recover")
    def recover():
        data = body()
        mode = data.get("mode")
        if mode not in ("username", "password"):
            raise RecoveryError("찾기 종류를 확인하세요.")
        question, answer = validate_quiz(data)
        member = data.get("memberNo")
        if not isinstance(member, str) or not re.fullmatch(r"[0-9]{4,20}", member):
            raise RecoveryError("회원번호는 숫자 4~20자로 입력하세요.")
        limit("member:" + member)
        filters = {"member_no": "eq." + member}
        if mode == "username":
            name = data.get("name")
            if not isinstance(name, str) or not 2 <= len(name.strip()) <= 40:
                raise RecoveryError("가입할 때 등록한 이름을 입력하세요.")
            # PostgREST quoted filter values also handle commas and parentheses in names safely.
            filters["name"] = 'eq."' + name.strip().replace('\\', '\\\\').replace('"', '\\"') + '"'
        else:
            username = data.get("username")
            if not isinstance(username, str) or not re.fullmatch(r"[a-z0-9._-]{4,30}", username.lower()):
                raise RecoveryError("아이디를 확인하세요.")
            filters["username"] = "eq." + username.lower()
            validate_password(data.get("newPassword"))
        profile = store.profile(**filters)
        saved = store.quiz(profile["id"]) if profile else None
        salt = saved["answer_salt"] if saved else "0" * 32
        expected = saved["answer_hash"] if saved else "0" * 64
        matched = hmac.compare_digest(answer_hash(answer, salt), expected)
        if not matched or not saved or saved["question"] != question or profile["status"] != "ACTIVE":
            raise RecoveryError(MISMATCH, 403)
        if mode == "username":
            return jsonify(ok=True, username=profile["username"])
        store.update_password(profile["id"], data["newPassword"])
        return jsonify(ok=True)

    @bp.post("/admin-reset")
    def admin_reset():
        user, _ = current_user()
        if user.get("app_metadata", {}).get("recovery_password_required") or not store.is_admin(user["id"]):
            raise RecoveryError("관리자만 비밀번호를 초기화할 수 있습니다.", 403)
        data = body()
        target = data.get("userId")
        if not isinstance(target, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", target) or target == user["id"]:
            raise RecoveryError("초기화할 다른 회원을 선택하세요.")
        limit("admin:" + user["id"])
        store.confirm_password(user, data.get("currentPassword"))
        profile = store.profile(id="eq." + target)
        if not profile or profile["status"] != "ACTIVE":
            raise RecoveryError("초기화할 수 있는 회원이 아닙니다.")
        temporary = "Nrc!7" + secrets.token_urlsafe(15)
        # Record intent before mutation; a failed audit write must never silently reset a password.
        store.audit(user["id"], target, "REQUESTED")
        store.update_password(target, temporary, temporary=True)
        store.audit(user["id"], target, "SUCCESS")
        return jsonify(ok=True, temporaryPassword=temporary, username=profile["username"])

    @bp.post("/change-password")
    def change_password():
        user, _ = current_user()
        data = body()
        password = validate_password(data.get("newPassword"))
        if password == data.get("currentPassword"):
            raise RecoveryError("임시 비밀번호와 다른 새 비밀번호를 입력하세요.")
        limit("change:" + user["id"])
        store.confirm_password(user, data.get("currentPassword"))
        # The Auth admin password-update endpoint revokes all refreshable sessions.
        store.update_password(user["id"], password)
        return jsonify(ok=True)

    return bp
