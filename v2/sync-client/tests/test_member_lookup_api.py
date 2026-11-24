import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api

TOKEN = "t" * 40
FAKE = {"name": "김정경", "payDate": "20261130", "total": 1, "members": [{"userId": "2913195", "role": "본"}]}
ACCOUNTS = [
    {"sourceAccountId": "qndnjsqlsim", "loginId": "qndnjsqlsim", "password": "pw-one"},
    {"sourceAccountId": "second", "loginId": "second", "password": "pw-two"},
]


class FetchCredentialsTests(unittest.TestCase):
    def test_uses_the_server_reveal_endpoint_with_the_login_token(self):
        reply = {"ok": True, "credentials": ACCOUNTS + [{"sourceAccountId": "x", "loginId": "x", "password": ""}]}
        with mock.patch.object(api.queue_worker, "_json_request", return_value=reply) as request:
            accounts = api.fetch_approved_credentials(TOKEN)
        self.assertTrue(request.call_args.args[0].endswith("/credentials/reveal"))
        self.assertEqual(request.call_args.kwargs["headers"]["Authorization"], f"Bearer {TOKEN}")
        self.assertEqual([row["loginId"] for row in accounts], ["qndnjsqlsim", "second"], "비밀번호 없는 항목은 제외")

    def test_unauthorized_becomes_permission_error(self):
        with mock.patch.object(api.queue_worker, "_json_request", side_effect=RuntimeError("서버 요청 실패(401): no")):
            with self.assertRaises(PermissionError):
                api.fetch_approved_credentials(TOKEN)

    def test_short_token_is_rejected_without_a_request(self):
        with mock.patch.object(api.queue_worker, "_json_request") as request:
            with self.assertRaises(PermissionError):
                api.fetch_approved_credentials("short")
        request.assert_not_called()


class LookupMemberRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = api.app.test_client()

    def post(self, body):
        return self.client.post("/lookup/member", json=body)

    def test_works_without_the_legacy_sync_token_and_without_local_credentials(self):
        # 이 PC의 Windows 자격 증명에는 계정이 없어도, 서버가 승인한 계정으로 로그인한다.
        with mock.patch.object(api, "fetch_approved_credentials", return_value=ACCOUNTS), \
             mock.patch.object(api, "run_member_lookup", return_value=FAKE) as lookup:
            response = self.post({"name": " 김정경 ", "accessToken": TOKEN})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])
        self.assertEqual(lookup.call_args.args[:3], ("김정경", "qndnjsqlsim", "pw-one"))

    def test_requested_account_is_used_when_approved(self):
        with mock.patch.object(api, "fetch_approved_credentials", return_value=ACCOUNTS), \
             mock.patch.object(api, "run_member_lookup", return_value=FAKE) as lookup:
            response = self.post({"name": "김정경", "accessToken": TOKEN, "sourceAccountId": "second"})
        self.assertEqual(lookup.call_args.args[:3], ("김정경", "second", "pw-two"))
        self.assertEqual(response.get_json()["sourceAccountId"], "second")

    def test_account_that_is_not_approved_is_refused(self):
        with mock.patch.object(api, "fetch_approved_credentials", return_value=ACCOUNTS), \
             mock.patch.object(api, "run_member_lookup") as lookup:
            response = self.post({"name": "김정경", "accessToken": TOKEN, "sourceAccountId": "someone-elses"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "ACCOUNT_NOT_APPROVED")
        lookup.assert_not_called()

    def test_no_approved_account(self):
        with mock.patch.object(api, "fetch_approved_credentials", return_value=[]), \
             mock.patch.object(api, "run_member_lookup") as lookup:
            response = self.post({"name": "김정경", "accessToken": TOKEN})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "NO_CREDENTIALS")
        lookup.assert_not_called()

    def test_invalid_login_token_is_rejected(self):
        with mock.patch.object(api, "fetch_approved_credentials", side_effect=PermissionError("401")), \
             mock.patch.object(api, "run_member_lookup") as lookup:
            response = self.post({"name": "김정경", "accessToken": TOKEN})
        self.assertEqual(response.status_code, 401)
        lookup.assert_not_called()

    def test_password_in_request_is_ignored(self):
        with mock.patch.object(api, "fetch_approved_credentials", return_value=ACCOUNTS), \
             mock.patch.object(api, "run_member_lookup", return_value=FAKE) as lookup:
            self.post({"name": "김정경", "accessToken": TOKEN, "loginId": "evil", "password": "evil1234"})
        self.assertEqual(lookup.call_args.args[:3], ("김정경", "qndnjsqlsim", "pw-one"))

    def test_server_unreachable_is_reported(self):
        with mock.patch.object(api, "fetch_approved_credentials", side_effect=RuntimeError("서버 연결 실패")):
            response = self.post({"name": "김정경", "accessToken": TOKEN})
        self.assertEqual(response.status_code, 502)

    def test_name_is_required_and_limited(self):
        self.assertEqual(self.post({"accessToken": TOKEN}).status_code, 400)
        self.assertEqual(self.post({"name": "가" * 31, "accessToken": TOKEN}).status_code, 400)

    def test_preflight_is_allowed_for_the_app_origin(self):
        response = self.client.options("/lookup/member", headers={
            "Origin": "https://prepaid1215.github.io", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type"})
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), "https://prepaid1215.github.io")

    def test_lookup_failure_is_reported(self):
        with mock.patch.object(api, "fetch_approved_credentials", return_value=ACCOUNTS), \
             mock.patch.object(api, "run_member_lookup", side_effect=RuntimeError("로그인 실패")):
            response = self.post({"name": "김정경", "accessToken": TOKEN})
        self.assertEqual(response.status_code, 500)
        self.assertIn("로그인 실패", response.get_json()["message"])


if __name__ == "__main__":
    unittest.main()
