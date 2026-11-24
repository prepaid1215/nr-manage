import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import queue_worker

JOB = {"id": "12345678-aaaa-bbbb-cccc-1234567890ab", "sourceAccountId": "qndnjsqlsim", "leaseToken": "lease",
       "credentials": {"loginId": "qndnjsqlsim", "password": "pw"},
       "trackedMembers": [{"userId": "2893497", "userName": "주영돈", "rankCd": "25", "rankName": "골드"},
                          {"userId": "2893498", "userName": "주영돈", "rankCd": "25", "rankName": "골드"}]}


def captured(function, *args, **kwargs):
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        try:
            function(*args, **kwargs)
            error = None
        except Exception as exc:  # noqa: BLE001
            error = exc
    return buffer.getvalue(), error


class LogEventTests(unittest.TestCase):
    def test_lines_carry_a_timestamp(self):
        text, _ = captured(queue_worker.log_event, "안녕")
        self.assertRegex(text, r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 안녕\n$")

    def test_repeated_messages_are_shortened_and_the_count_is_reported(self):
        queue_worker._throttle.clear()
        with mock.patch.object(queue_worker.time, "time", side_effect=[1000, 1001, 1002, 1003, 1400]):
            first, _ = captured(queue_worker.log_throttled, "k", "오류 A")
            second, _ = captured(queue_worker.log_throttled, "k", "오류 A")
            third, _ = captured(queue_worker.log_throttled, "k", "오류 A")
            other, _ = captured(queue_worker.log_throttled, "k", "오류 B")
            later, _ = captured(queue_worker.log_throttled, "k", "오류 B")
        self.assertIn("오류 A", first)
        self.assertEqual((second, third), ("", ""))
        self.assertIn("오류 B", other, "내용이 바뀌면 바로 남긴다")
        self.assertIn("오류 B", later, "5분이 지나면 다시 남긴다")


class ProcessJobLogTests(unittest.TestCase):
    def setUp(self):
        queue_worker._throttle.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patches = [
            mock.patch.object(queue_worker, "DATA_DIR", Path(self.tmp.name)),
            mock.patch.object(queue_worker, "_load_device", return_value={"id": "dev-1"}),
            mock.patch.object(queue_worker, "heartbeat", return_value=True),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.coordinator = mock.patch.object(queue_worker, "_coordinator").start()
        self.addCleanup(mock.patch.stopall)

    def test_success_is_logged_from_start_to_upload(self):
        combined = {"sourceAccountId": "qndnjsqlsim", "rstLst": [{}] * 206, "trackedMembers": [{}, {}]}
        with mock.patch.object(queue_worker, "run_combined"), mock.patch.object(queue_worker, "_load_combined", return_value=combined):
            text, error = captured(queue_worker.process_job, JOB)
        self.assertIsNone(error)
        self.assertIn("수집 시작: 작업 12345678 · NRC 계정 qndnjsqlsim · 등록 회원 2개", text)
        self.assertIn("계보 206명 · 등록 회원 2/2개 읽음", text)
        self.assertIn("결과 업로드 완료: 작업 12345678", text)
        self.assertNotIn("pw", text, "비밀번호는 로그에 남기지 않는다")

    def test_failure_is_logged_reported_and_marked(self):
        with mock.patch.object(queue_worker, "run_combined", side_effect=RuntimeError("로그인 실패")):
            text, error = captured(queue_worker.process_job, JOB)
        self.assertIsInstance(error, RuntimeError)
        self.assertTrue(getattr(error, "nrc_logged", False))
        self.assertIn("수집 실패", text)
        self.assertIn("로그인 실패", text)
        sent = self.coordinator.call_args.args[1]
        self.assertEqual(sent["error"], "로그인 실패", "서버에도 실패를 알린다")

    def test_missing_result_file_is_logged(self):
        with mock.patch.object(queue_worker, "run_combined"):
            text, error = captured(queue_worker.process_job, JOB)
        self.assertIn("수집 결과 JSON이 만들어지지 않았습니다", text)

    def test_tracked_members_are_cleared_after_the_run(self):
        with mock.patch.object(queue_worker, "run_combined"), mock.patch.object(queue_worker, "_load_combined", return_value={"sourceAccountId": "qndnjsqlsim"}):
            captured(queue_worker.process_job, JOB)
        self.assertEqual(queue_worker.scraper_module.TRACKED_MEMBERS, [])


class ClaimLogTests(unittest.TestCase):
    def setUp(self):
        queue_worker._throttle.clear()
        mock.patch.object(queue_worker, "_load_device", return_value={"id": "dev-1"}).start()
        self.addCleanup(mock.patch.stopall)

    def test_slow_claim_is_logged(self):
        ticks = iter([0, 12, 12, 12])
        with mock.patch.object(queue_worker.time, "time", side_effect=lambda: next(ticks)), \
             mock.patch.object(queue_worker, "_coordinator", return_value={"ok": True, "job": None}):
            text, _ = captured(queue_worker.claim_job)
        self.assertIn("작업 요청 응답이 느립니다(12초)", text)

    def test_fast_claim_is_silent(self):
        ticks = iter([0, 1, 1, 1])
        with mock.patch.object(queue_worker.time, "time", side_effect=lambda: next(ticks)), \
             mock.patch.object(queue_worker, "_coordinator", return_value={"ok": True, "job": None}):
            text, _ = captured(queue_worker.claim_job)
        self.assertEqual(text, "")

    def test_update_required_is_logged(self):
        with mock.patch.object(queue_worker, "_coordinator", return_value={"ok": True, "job": None, "updateRequired": True}):
            text, _ = captured(queue_worker.claim_job)
        self.assertIn("업데이트가 필요한 버전", text)


if __name__ == "__main__":
    unittest.main()
