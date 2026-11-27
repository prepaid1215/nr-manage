import contextlib
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import queue_worker as worker

DEAD = '{"code":400,"error_code":"refresh_token_already_used","msg":"Invalid Refresh Token: Already Used"}'


def http_error(code, body='{"message":"x"}'):
    return urllib.error.HTTPError("https://x", code, "err", {}, io.BytesIO(body.encode()))


class Reply:
    def __init__(self, data):
        self.data = json.dumps(data).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self.data


class RetryTests(unittest.TestCase):
    def setUp(self):
        sleeper = mock.patch.object(worker.time, "sleep")
        self.sleep = sleeper.start()
        self.addCleanup(sleeper.stop)

    def test_transient_server_errors_are_retried_when_allowed(self):
        with mock.patch.object(worker.urllib.request, "urlopen", side_effect=[http_error(502), http_error(520), Reply({"ok": 1})]) as opened:
            self.assertEqual(worker._json_request("https://x", retry=True), {"ok": 1})
        self.assertEqual(opened.call_count, 3)

    def test_errors_are_not_retried_by_default(self):
        with mock.patch.object(worker.urllib.request, "urlopen", side_effect=[http_error(502)]) as opened:
            with self.assertRaises(worker.ServerError) as caught:
                worker._json_request("https://x")
        self.assertEqual(opened.call_count, 1, "작업 배정·완료 같은 요청은 중복 전송하지 않는다")
        self.assertEqual(caught.exception.status, 502)

    def test_client_errors_are_never_retried(self):
        with mock.patch.object(worker.urllib.request, "urlopen", side_effect=[http_error(400, DEAD)]) as opened:
            with self.assertRaises(worker.ServerError):
                worker._json_request("https://x", retry=True)
        self.assertEqual(opened.call_count, 1)

    def test_timeouts_and_connection_errors_are_retried(self):
        with mock.patch.object(worker.urllib.request, "urlopen",
                               side_effect=[TimeoutError("timed out"), urllib.error.URLError("reset"), Reply({"ok": 2})]) as opened:
            self.assertEqual(worker._json_request("https://x", retry=True), {"ok": 2})
        self.assertEqual(opened.call_count, 3)

    def test_gives_up_after_three_attempts(self):
        with mock.patch.object(worker.urllib.request, "urlopen", side_effect=[http_error(503)] * 3) as opened:
            with self.assertRaises(worker.ServerError):
                worker._json_request("https://x", retry=True)
        self.assertEqual(opened.call_count, 3)

    def test_error_message_format_is_unchanged(self):
        with mock.patch.object(worker.urllib.request, "urlopen", side_effect=[http_error(401, '{"message":"만료"}')]):
            with self.assertRaises(RuntimeError) as caught:
                worker._json_request("https://x")
        self.assertEqual(str(caught.exception), "서버 요청 실패(401): 만료")


class DeadSessionTests(unittest.TestCase):
    def setUp(self):
        worker._throttle.clear()
        worker._cached_auth.clear()
        worker._session_state.update(needs=False, checkedAt=0.0)
        self.addCleanup(lambda: worker._session_state.update(needs=False, checkedAt=0.0))
        self.addCleanup(worker._cached_auth.clear)
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(worker, "_load_device", return_value={"id": "dev-1"}).start()
        self.keyring = mock.patch.object(worker, "keyring").start()
        self.keyring.get_password.return_value = json.dumps({"userId": "u", "refreshToken": "old"})
        mock.patch.object(worker.time, "sleep").start()
        self.log = io.StringIO()

    def token(self):
        with contextlib.redirect_stdout(self.log):
            return worker._access_token()

    def test_dead_refresh_token_asks_for_reregistration_once(self):
        failure = worker.ServerError(400, DEAD, DEAD)
        with mock.patch.object(worker, "_json_request", side_effect=failure) as request:
            with self.assertRaises(worker.ReregisterNeeded):
                self.token()
            with self.assertRaises(worker.ReregisterNeeded):
                self.token()
        self.assertEqual(request.call_count, 1, "5분 안에는 서버에 다시 묻지 않는다")
        self.assertTrue(worker.local_device_status()["needsReregister"])
        self.assertEqual(self.log.getvalue().count("다시 등록"), 1, "안내는 한 번만 남긴다")
        self.assertNotIn("old", self.log.getvalue(), "토큰은 로그에 남기지 않는다")

    def test_it_checks_again_after_five_minutes_and_recovers(self):
        worker._session_state.update(needs=True, checkedAt=1000.0)
        reply = {"access_token": "new", "refresh_token": "next", "expires_in": 3600}
        with mock.patch.object(worker.time, "time", return_value=1000.0 + worker.REREGISTER_RECHECK_SECONDS + 1), \
             mock.patch.object(worker, "_json_request", return_value=reply):
            self.assertEqual(self.token(), "new")
        self.assertFalse(worker.local_device_status()["needsReregister"])

    def test_temporary_server_failure_is_not_treated_as_dead_session(self):
        with mock.patch.object(worker, "_json_request", side_effect=worker.ServerError(502, "bad gateway", "<html>")):
            with self.assertRaises(worker.ServerError):
                self.token()
        self.assertFalse(worker.local_device_status()["needsReregister"])
        self.assertEqual(self.keyring.set_password.call_count, 0, "저장된 토큰을 건드리지 않는다")

    def test_refresh_is_requested_with_retry_and_same_token(self):
        reply = {"access_token": "new", "refresh_token": "next", "expires_in": 3600}
        with mock.patch.object(worker, "_json_request", return_value=reply) as request:
            self.token()
        self.assertTrue(request.call_args.kwargs["retry"])
        self.assertEqual(request.call_args.kwargs["body"], {"refresh_token": "old"})


if __name__ == "__main__":
    unittest.main()
