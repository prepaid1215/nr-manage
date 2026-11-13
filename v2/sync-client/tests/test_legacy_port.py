"""Regression tests for the local 5050 port handoff on existing PCs."""
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import legacy_port as port


def legacy(pid=1254):
    return {
        "pid": pid, "name": "pythonw.exe", "user": "testuser",
        "command": '"C:\\Python312\\pythonw.exe" -B "C:\\Users\\testuser\\Downloads\\NRC-Sync-Desktop\\api.py"',
    }


class GuardTests(unittest.TestCase):
    def test_exact_old_script_and_owner_required(self):
        self.assertTrue(port.is_verified_legacy(legacy(), username="testuser"))
        for changed in (
            {"name": "NRCSync.exe"},
            {"command": '"C:\\Temp\\other\\api.py"'},
            {"command": '"C:\\Temp\\NRC-Sync-Desktop\\other.py"'},
            {"user": "anotheruser"},
            {"pid": "1254"},
        ):
            self.assertFalse(port.is_verified_legacy({**legacy(), **changed}, username="testuser"))

    def test_unrelated_listener_is_never_stopped(self):
        with patch.object(port, "port_available", return_value=False), \
             patch.object(port, "find_port_owners", return_value=[
                 {"pid": 1, "name": "pythonw.exe", "user": "testuser", "command": "another.py"}
             ]), patch.object(port, "_message") as message, \
             patch.object(port, "stop_legacy_process") as kill:
            self.assertFalse(port.ensure_local_port_ready())
            kill.assert_not_called()
            message.assert_called_once()

    def test_decline_keeps_legacy_running(self):
        with patch.object(port, "port_available", return_value=False), \
             patch.object(port, "find_port_owners", return_value=[legacy()]), \
             patch.dict(os.environ, {"USERNAME": "testuser"}), \
             patch.object(port, "_message", return_value=False), \
             patch.object(port, "stop_legacy_process") as kill:
            self.assertFalse(port.ensure_local_port_ready())
            kill.assert_not_called()

    def test_confirmed_old_listener_handoff(self):
        with patch.object(port, "port_available", side_effect=[False, True]), \
             patch.object(port, "find_port_owners", return_value=[legacy()]), \
             patch.dict(os.environ, {"USERNAME": "testuser"}), \
             patch.object(port, "_message", return_value=True), \
             patch.object(port, "stop_legacy_process") as kill, \
             patch.object(port, "disable_known_legacy_startups") as backup:
            self.assertTrue(port.ensure_local_port_ready())
            kill.assert_called_once_with(legacy())
            backup.assert_called_once()

    def test_stale_pid_is_never_killed(self):
        with patch.dict(os.environ, {"USERNAME": "testuser"}), \
             patch.object(port, "find_port_owners", return_value=[{
                 **legacy(), "command": "pythonw.exe unrelated.py"
             }]), patch.object(port.subprocess, "run") as shell:
            with self.assertRaises(RuntimeError):
                port.stop_legacy_process(legacy())
            shell.assert_not_called()

    def test_only_exact_startup_script_is_moved_not_deleted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            startup = root / "roaming/Microsoft/Windows/Start Menu/Programs/Startup"
            startup.mkdir(parents=True)
            old = startup / "LegacyNRC.vbs"
            old.write_text('CreateObject("WScript.Shell").Run "pythonw.exe -B C:\\Users\\user\\Downloads\\NRC-Sync-Desktop\\api.py"', encoding="utf-8")
            other = startup / "OtherPython.vbs"
            other.write_text('pythonw.exe -B C:\\Tools\\api.py', encoding="utf-8")
            with patch.dict(os.environ, {"APPDATA": str(root / "roaming"), "LOCALAPPDATA": str(root / "local")}):
                affected = port.disable_known_legacy_startups()
            self.assertEqual(affected, ["시작프로그램: LegacyNRC.vbs"])
            self.assertFalse(old.exists())
            self.assertTrue(other.exists())
            self.assertTrue((root / "local/NRCSync/legacy-startup-backup/LegacyNRC.vbs.disabled").is_file())


@unittest.skipUnless(os.name == "nt", "Windows-specific end-to-end process ownership test")
class WindowsIntegrationTests(unittest.TestCase):
    def test_real_python_listener_can_be_identified_and_stopped(self):
        if not port.port_available():
            self.skipTest("5050 is already in use")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "NRC-Sync-Desktop"
            root.mkdir()
            source = root / "api.py"
            source.write_text(
                "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
                "class H(BaseHTTPRequestHandler):\n"
                " def do_GET(self):\n"
                "  self.send_response(404)\n"
                "  self.end_headers()\n"
                "HTTPServer(('127.0.0.1', 5050), H).serve_forever()\n",
                encoding="utf-8",
            )
            pythonw = Path(sys.executable).with_name("pythonw.exe")
            if not pythonw.is_file():
                self.skipTest("pythonw.exe unavailable")
            fake = subprocess.Popen([str(pythonw), "-B", str(source)],
                                    creationflags=port._NO_WINDOW)
            try:
                for _ in range(80):
                    if not port.port_available():
                        break
                    time.sleep(0.2)
                self.assertFalse(port.port_available(), "fixture failed to bind localhost:5050")
                holders = port.find_port_owners()
                self.assertEqual(len(holders), 1, holders)
                self.assertTrue(port.is_verified_legacy(holders[0]), holders)
                with patch.object(port, "_message", return_value=True), \
                     patch.object(port, "disable_known_legacy_startups", return_value=[]):
                    self.assertTrue(port.ensure_local_port_ready())
                self.assertTrue(port.port_available())
            finally:
                if fake.poll() is None:
                    fake.terminate()
                    fake.wait(timeout=8)


if __name__ == "__main__":
    unittest.main()
