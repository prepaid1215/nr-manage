import hashlib
import io
import json
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import auto_update as update
from work_guard import ActivityGate


def image():
    data = bytearray(256)
    data[:2] = b'MZ'
    struct.pack_into('<I', data, 60, 128)
    data[128:134] = b'PE\x00\x00\x64\x86'
    return bytes(data)


def manifest():
    data = image()
    return dict(schema=1, release=update.APP_RELEASE + 1, collectorVersion='test-next',
                bytes=len(data), sha256=hashlib.sha256(data).hexdigest())


class Reply(io.BytesIO):
    def __init__(self, data, length=None):
        super().__init__(data)
        self.headers = {'Content-Length': str(len(data) if length is None else length)}


class DownloadTests(unittest.TestCase):
    def test_verified_download(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'stage.exe'
            urls = []
            def opener(url):
                urls.append(url)
                return Reply(image())
            update.download_artifact(manifest(), target, opener)
            self.assertEqual(target.read_bytes(), image())
            self.assertEqual(urls, [update.ARTIFACT_URL])
            self.assertFalse(target.with_suffix('.part').exists())

    def test_corrupt_truncated_oversize_and_html_downloads_never_publish(self):
        for data in (b'bad', image() + b'extra', b'X' * 256, image()[:-1]):
            with self.subTest(size=len(data)), tempfile.TemporaryDirectory() as folder:
                target = Path(folder) / 'stage.exe'
                with self.assertRaises(ValueError):
                    update.download_artifact(manifest(), target, lambda _: Reply(data))
                self.assertFalse(target.exists())
                self.assertFalse(target.with_suffix('.part').exists())

    def test_digest_and_pe_signature_both_required(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'stage.exe'
            body = b'X' * 256
            invalid = {**manifest(), 'sha256': hashlib.sha256(body).hexdigest()}
            with self.assertRaises(ValueError):
                update.download_artifact(invalid, target, lambda _: Reply(body))

    def test_manifest_bounds_and_boolean_versions(self):
        for changes in ({'schema':2}, {'release':True}, {'release':-1}, {'bytes':update.MAX_BYTES+1}, {'sha256':'bad'}, {'collectorVersion':'<script>'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                update.validate_manifest({**manifest(), **changes})

    def test_fixed_publisher_only(self):
        with self.assertRaises(ValueError):
            update.open_publisher('https://other.example/program.exe')

    def test_manifest_size_limit(self):
        with self.assertRaises(ValueError):
            update.fetch_manifest(lambda _: Reply(b'x' * 16385))


class ApplyTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.updates = self.root / 'updates'
        self.updates.mkdir()
        self.target = self.root / 'NRCSync.exe'
        self.target.write_bytes(b'previous-known-good')
        self.profile = self.root / 'data' / 'worker_device.json'
        self.profile.parent.mkdir()
        self.profile.write_text('existing-device')
        self.stage = self.updates / ('stage-123-' + 'a' * 32 + '.exe')
        self.stage.write_bytes(image())
        self.plan = self.updates / ('plan-' + 'b' * 32 + '.json')
        update.atomic_json(self.plan, dict(stage=self.stage.name, manifest=manifest(), oldPid=12345))

    def test_success_waits_for_old_process_keeps_backup_and_settings(self):
        process = Mock()
        launch = Mock(return_value=process)
        wait = Mock(return_value=True)
        self.assertTrue(update.apply_update(self.plan, self.root, wait_exit=wait, launch=launch, health=lambda *a: True))
        wait.assert_called_once_with(12345)
        self.assertEqual(self.target.read_bytes(), image())
        self.assertEqual((self.updates/'last-good.exe').read_bytes(), b'previous-known-good')
        self.assertEqual(self.profile.read_text(), 'existing-device')
        self.assertEqual(update.read_json(self.updates/'state.json')['status'], 'updated')
        self.assertFalse(self.plan.exists())

    def test_unhealthy_new_program_is_stopped_and_old_version_restarted(self):
        new_process, restored_process = Mock(), Mock()
        launch = Mock(side_effect=[new_process, restored_process])
        stop = Mock()
        self.assertFalse(update.apply_update(self.plan, self.root, wait_exit=lambda _: True,
                                            launch=launch, health=lambda *a: False, stop=stop))
        stop.assert_called_once_with(new_process)
        self.assertEqual(launch.call_count, 2)
        self.assertEqual(self.target.read_bytes(), b'previous-known-good')
        self.assertEqual(self.profile.read_text(), 'existing-device')
        self.assertEqual(update.read_json(self.updates/'state.json')['failedRelease'], manifest()['release'])

    def test_failure_to_start_new_program_still_restores_old(self):
        launch = Mock(side_effect=[OSError('launch failed'), Mock()])
        self.assertFalse(update.apply_update(self.plan, self.root, wait_exit=lambda _: True, launch=launch, stop=Mock()))
        self.assertEqual(self.target.read_bytes(), b'previous-known-good')

    def test_existing_process_timeout_does_not_replace_or_launch(self):
        launch = Mock()
        self.assertFalse(update.apply_update(self.plan, self.root, wait_exit=lambda _: False, launch=launch))
        launch.assert_not_called()
        self.assertEqual(self.target.read_bytes(), b'previous-known-good')
        self.assertFalse(self.plan.with_suffix('.ready.json').exists())

    def test_tampering_and_traversal_never_replace(self):
        for changes in ({'stage':'../outside.exe'}, {'oldPid':False}, {'manifest':{'disabled':True}}):
            data = update.read_json(self.plan)
            update.atomic_json(self.plan, {**data, **changes})
            with self.assertRaises((ValueError, KeyError)):
                update.validate_plan(self.plan, self.root)
        self.assertEqual(self.target.read_bytes(), b'previous-known-good')

    def test_changed_stage_is_rejected_before_any_swap(self):
        self.stage.write_bytes(b'changed')
        launch = Mock()
        with self.assertRaises(ValueError):
            update.apply_update(self.plan, self.root, launch=launch)
        launch.assert_not_called()
        self.assertEqual(self.target.read_bytes(), b'previous-known-good')


class GateTests(unittest.TestCase):
    def test_running_work_is_never_interrupted(self):
        gate = ActivityGate()
        entered, finish = threading.Event(), threading.Event()
        worker = gate.start_thread(lambda: (entered.set(), finish.wait(2)))
        self.assertTrue(entered.wait(1))
        self.assertFalse(gate.pause(timeout=0.02))
        finish.set()
        worker.join(1)
        self.assertTrue(gate.pause(timeout=1))
        gate.resume()

    def test_nested_existing_work_can_finish_while_update_waits(self):
        gate = ActivityGate()
        done = threading.Event()
        with gate.activity():
            pauser = threading.Thread(target=lambda: (gate.pause(timeout=2), done.set()))
            pauser.start()
            deadline = time.monotonic()+1
            while not gate._paused and time.monotonic() < deadline:
                time.sleep(.001)
            with gate.activity():
                self.assertFalse(done.is_set())
            child_done = threading.Event()
            child = gate.start_thread(child_done.set)
            self.assertTrue(child_done.wait(1))
            child.join(1)
        self.assertTrue(done.wait(1))
        gate.resume()
        pauser.join(1)


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        (self.root/'NRCSync.exe').write_bytes(b'old')
        self.fetch = Mock(return_value=manifest())
        self.download = Mock(side_effect=lambda m,p: p.write_bytes(image()))
        self.gate = ActivityGate()
        self.manager = update.UpdateManager(self.root, self.root/'NRCSync.exe', True, self.gate, self.fetch, self.download)

    def test_no_update_or_downgrade(self):
        for release in (update.APP_RELEASE, update.APP_RELEASE-1):
            self.fetch.return_value = {**manifest(), 'release':release}
            self.assertFalse(self.manager.check_once())
        self.download.assert_not_called()

    def test_disabled_release_is_never_downloaded(self):
        self.fetch.return_value = {'disabled':True}
        self.assertFalse(self.manager.check_once())
        self.download.assert_not_called()
        self.assertEqual(self.manager.snapshot()['status'], 'paused')

    def test_verified_handoff_only_after_idle(self):
        entered, finish = threading.Event(), threading.Event()
        worker = self.gate.start_thread(lambda:(entered.set(),finish.wait(2)))
        self.assertTrue(entered.wait(1))
        handed_off = threading.Event()
        thread = threading.Thread(target=lambda:self.manager.check_once(lambda *a:handed_off.set()))
        thread.start()
        time.sleep(.03)
        self.assertFalse(handed_off.is_set())
        finish.set()
        thread.join(2)
        worker.join(1)
        self.assertTrue(handed_off.is_set())
        self.assertEqual(self.gate.active, 0)

    def test_failed_release_cooldown(self):
        updates = self.root/'updates'
        updates.mkdir()
        update.atomic_json(updates/'state.json', {'failedRelease':manifest()['release'],'failedAt':time.time()})
        self.assertFalse(self.manager.check_once())
        self.download.assert_not_called()

    def test_uninstalled_or_developer_run_never_replaces(self):
        self.manager.frozen = False
        self.assertFalse(self.manager.check_once())
        self.fetch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
