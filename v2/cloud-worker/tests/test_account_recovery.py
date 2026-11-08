import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from account_recovery import (MISMATCH, QUESTIONS, RecoveryError, SupabaseRecoveryStore,
                              answer_hash, create_recovery_blueprint)

USER_ID = "11111111-1111-4111-8111-111111111111"
ADMIN_ID = "22222222-2222-4222-8222-222222222222"


class FakeStore:
    def __init__(self):
        self.profiles = {
            USER_ID: dict(id=USER_ID, username="member01", member_no="12345", name="테스트회원", status="ACTIVE"),
            ADMIN_ID: dict(id=ADMIN_ID, username="admin01", member_no="54321", name="관리자", status="ACTIVE"),
        }
        self.users = {key: dict(id=key, email=f"{key}@example.invalid", app_metadata={}) for key in self.profiles}
        self.quizzes, self.counts, self.updates, self.audits = {}, {}, [], []
        self.admins = {ADMIN_ID}
        self.passwords = {key: "Current!123" for key in self.users}

    def user(self, token):
        if token not in self.users:
            raise RecoveryError("다시 로그인해 주세요.", 401)
        return self.users[token]

    def profile(self, **filters):
        for profile in self.profiles.values():
            if all(profile.get(key) == value[3:].strip('"') for key, value in filters.items()):
                return profile

    def allowed(self, account_key, client_key):
        for key in ("account:" + account_key, "client:" + client_key):
            self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts["account:" + account_key] <= 5 and self.counts["client:" + client_key] <= 30

    def confirm_password(self, user, password):
        if password != self.passwords[user["id"]]:
            raise RecoveryError("현재 비밀번호가 일치하지 않습니다.", 403)

    def quiz(self, user_id):
        return self.quizzes.get(user_id)

    def save_quiz(self, user_id, question, answer):
        salt = "1234567890abcdef" * 2
        self.quizzes[user_id] = dict(question=question, answer_salt=salt, answer_hash=answer_hash(answer, salt))

    def is_admin(self, user_id):
        return user_id in self.admins

    def update_password(self, user_id, password, temporary=False):
        self.updates.append((user_id, password, temporary))
        self.passwords[user_id] = password
        self.users[user_id]["app_metadata"]["recovery_password_required"] = temporary

    def audit(self, actor_id, target_id, result):
        self.audits.append((actor_id, target_id, result))


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        app = Flask(__name__)
        app.register_blueprint(create_recovery_blueprint(self.store, "test-server-key", "https://app.example"))
        self.client = app.test_client()

    def post(self, path, body, user=None, **kwargs):
        headers = {"Origin": "https://app.example"}
        if user:
            headers["Authorization"] = "Bearer " + user
        return self.client.post("/account-recovery/" + path, json=body, headers=headers, **kwargs)

    def recovery(self, **changes):
        data = dict(mode="username", name="테스트회원", memberNo="12345", question="secret_word", answer="Secret  Place")
        data.update(changes)
        return data

    def register(self):
        self.store.save_quiz(USER_ID, "secret_word", "Secret Place")

    def test_scrypt_normalization_and_unique_salts(self):
        salt = "1" * 32
        self.assertEqual(answer_hash("  Ｓｅｃｒｅｔ   Place  ", salt), answer_hash("secret place", salt))
        self.assertNotEqual(answer_hash("secret place", salt), answer_hash("secret place", "2" * 32))

    def test_quiz_requires_login_and_current_password(self):
        body = dict(question="secret_word", answer="비밀단어", currentPassword="wrong")
        self.assertEqual(self.post("quiz", body).status_code, 401)
        self.assertEqual(self.post("quiz", body, USER_ID).status_code, 403)
        self.assertFalse(self.store.quizzes)
        body["currentPassword"] = "Current!123"
        self.assertEqual(self.post("quiz", body, USER_ID).status_code, 200)
        response = self.client.get("/account-recovery/quiz", headers={"Authorization": "Bearer " + USER_ID})
        self.assertEqual(response.json, dict(ok=True, configured=True, question="secret_word"))
        self.assertNotIn("answer", response.text)

    def test_find_username_and_reset_password(self):
        self.register()
        response = self.post("recover", self.recovery())
        self.assertEqual(response.json, dict(ok=True, username="member01"))
        response = self.post("recover", self.recovery(mode="password", username="MEMBER01", newPassword="Changed!123"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.store.updates, [(USER_ID, "Changed!123", False)])
        self.assertNotIn("Changed!123", response.text)

    def test_wrong_unknown_unconfigured_and_suspended_have_same_error(self):
        self.register()
        responses = [self.post("recover", self.recovery(answer="wrong")),
                     self.post("recover", self.recovery(memberNo="99999"))]
        self.store.profiles[USER_ID]["status"] = "SUSPENDED"
        responses.append(self.post("recover", self.recovery()))
        self.store.quizzes.clear()
        responses.append(self.post("recover", self.recovery()))
        self.assertTrue(all(r.status_code == 403 and r.json["message"] == MISMATCH for r in responses))
        self.assertFalse(self.store.updates)

    def test_limits_shared_between_find_and_reset_and_even_correct_answer(self):
        self.register()
        for i in range(5):
            data = self.recovery(answer="wrong") if i % 2 else self.recovery(
                mode="password", username="member01", newPassword="Changed!123", answer="wrong")
            self.assertEqual(self.post("recover", data).status_code, 403)
        response = self.post("recover", self.recovery())
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["Retry-After"], "900")
        self.assertFalse(self.store.updates)

    def test_untrusted_origin_and_malformed_payload(self):
        response = self.client.post("/account-recovery/recover", json={}, headers={"Origin": "https://evil.example"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.post("recover", ["bad"]).status_code, 400)
        self.assertEqual(self.post("recover", self.recovery(question=[])).status_code, 400)
        self.assertEqual(self.post("recover", self.recovery(memberNo="1 or true")).status_code, 400)

    def test_regular_user_cannot_reset_even_if_metadata_claims_admin(self):
        self.store.users[USER_ID]["app_metadata"]["admin"] = True
        response = self.post("admin-reset", dict(userId=ADMIN_ID, currentPassword="Current!123"), USER_ID)
        self.assertEqual(response.status_code, 403)
        self.assertFalse(self.store.updates)

    def test_admin_requires_password_and_cannot_reset_self(self):
        response = self.post("admin-reset", dict(userId=USER_ID, currentPassword="wrong"), ADMIN_ID)
        self.assertEqual(response.status_code, 403)
        response = self.post("admin-reset", dict(userId=ADMIN_ID, currentPassword="Current!123"), ADMIN_ID)
        self.assertEqual(response.status_code, 400)
        self.assertFalse(self.store.updates)

    def test_admin_reset_generates_random_temporary_password_and_audits_without_secret(self):
        body = dict(userId=USER_ID, currentPassword="Current!123")
        first = self.post("admin-reset", body, ADMIN_ID)
        second = self.post("admin-reset", body, ADMIN_ID)
        self.assertEqual(first.status_code, 200)
        self.assertNotEqual(first.json["temporaryPassword"], second.json["temporaryPassword"])
        self.assertTrue(self.store.updates[0][2])
        self.assertEqual(self.store.audits[:2], [(ADMIN_ID, USER_ID, "REQUESTED"), (ADMIN_ID, USER_ID, "SUCCESS")])
        self.assertNotIn(first.json["temporaryPassword"], str(self.store.audits))
        self.assertEqual(first.headers["Cache-Control"], "no-store")

    def test_audit_failure_prevents_reset(self):
        self.store.audit = Mock(side_effect=RuntimeError("private database detail"))
        response = self.post("admin-reset", dict(userId=USER_ID, currentPassword="Current!123"), ADMIN_ID)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private database", response.text)
        self.assertFalse(self.store.updates)

    def test_temporary_password_must_be_changed_before_quiz_setup(self):
        self.store.users[USER_ID]["app_metadata"]["recovery_password_required"] = True
        self.assertEqual(self.post("quiz", dict(question="secret_word", answer="answer", currentPassword="Current!123"), USER_ID).status_code, 403)
        response = self.post("change-password", dict(currentPassword="Current!123", newPassword="Changed!123"), USER_ID)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.store.users[USER_ID]["app_metadata"]["recovery_password_required"])

    def test_wrong_or_short_new_password_never_changes_account(self):
        self.assertEqual(self.post("change-password", dict(currentPassword="wrong", newPassword="Changed!123"), USER_ID).status_code, 403)
        self.assertEqual(self.post("change-password", dict(currentPassword="Current!123", newPassword="short"), USER_ID).status_code, 400)
        self.assertEqual(self.post("change-password", dict(currentPassword="Current!123", newPassword="Current!123"), USER_ID).status_code, 400)
        self.assertFalse(self.store.updates)


class TransportTests(unittest.TestCase):
    def test_password_confirmation_disposes_temporary_session(self):
        store = SupabaseRecoveryStore("https://example.invalid", "anon-test", "server-test")
        response = Mock(status_code=200)
        response.json.return_value = dict(user={"id": USER_ID}, access_token="temporary-session")
        with patch("account_recovery.requests.post", return_value=response), patch.object(store, "call") as call:
            store.confirm_password(dict(id=USER_ID, email="user@example.invalid"), "Current!123")
        call.assert_called_once_with("/auth/v1/logout?scope=local", "POST", token="temporary-session")

    def test_update_uses_admin_endpoint_and_server_metadata(self):
        store = SupabaseRecoveryStore("https://example.invalid", "anon-test", "server-test")
        with patch.object(store, "call") as call:
            store.update_password(USER_ID, "Temporary!123", temporary=True)
        call.assert_called_once_with("/auth/v1/admin/users/" + USER_ID, "PUT", {
            "password": "Temporary!123", "app_metadata": {"recovery_password_required": True}})


if __name__ == "__main__":
    unittest.main()
