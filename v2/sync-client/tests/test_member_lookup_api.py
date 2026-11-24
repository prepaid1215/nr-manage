import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api

TOKEN = "t" * 40
FAKE = {"name": "김정경", "payDate": "20261130", "total": 1, "members": [{"userId": "2913195", "role": "본"}]}
CREDS = '{"loginId":"abcd","password":"pw12345"}'


class LookupMemberRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = api.app.test_client()

    def post(self, body, **headers):
        return self.client.post("/lookup/member", json=body, headers=headers)

    def test_works_without_the_legacy_sync_token(self):
        # /api/* 는 연결 코드가 필요하지만 이 경로는 로그인 토큰으로 확인한다.
        with mock.patch.object(api, "verify_app_user", return_value="user-1"), \
             mock.patch.object(api.keyring, "get_password", return_value=CREDS), \
             mock.patch.object(api, "run_member_lookup", return_value=FAKE) as lookup:
            response = self.post({"name": " 김정경 ", "accessToken": TOKEN})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])
        self.assertEqual(lookup.call_args.args[:3], ("김정경", "abcd", "pw12345"))

    def test_credentials_are_looked_up_for_the_verified_user_only(self):
        with mock.patch.object(api, "verify_app_user", return_value="verified-user"), \
             mock.patch.object(api.keyring, "get_password", return_value=None) as keyring_get:
            response = self.post({"name": "김정경", "accessToken": TOKEN, "appUserId": "someone-else"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "NO_CREDENTIALS")
        self.assertEqual(keyring_get.call_args.args[1], "verified-user")

    def test_invalid_login_token_is_rejected(self):
        with mock.patch.object(api, "verify_app_user", return_value=""), \
             mock.patch.object(api, "run_member_lookup") as lookup:
            response = self.post({"name": "김정경", "accessToken": TOKEN})
        self.assertEqual(response.status_code, 401)
        lookup.assert_not_called()

    def test_password_in_request_is_ignored(self):
        with mock.patch.object(api, "verify_app_user", return_value="u"), \
             mock.patch.object(api.keyring, "get_password", return_value=None), \
             mock.patch.object(api, "run_member_lookup") as lookup:
            response = self.post({"name": "김정경", "accessToken": TOKEN, "loginId": "evil", "password": "evil1234"})
        self.assertEqual(response.status_code, 400)
        lookup.assert_not_called()

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
        with mock.patch.object(api, "verify_app_user", return_value="u"), \
             mock.patch.object(api.keyring, "get_password", return_value=CREDS), \
             mock.patch.object(api, "run_member_lookup", side_effect=RuntimeError("로그인 실패")):
            response = self.post({"name": "김정경", "accessToken": TOKEN})
        self.assertEqual(response.status_code, 500)
        self.assertIn("로그인 실패", response.get_json()["message"])


if __name__ == "__main__":
    unittest.main()
