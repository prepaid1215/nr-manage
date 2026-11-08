"""Verified downloads and Windows one-file replacement with health-checked rollback."""
import ctypes
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path

from sync_version import APP_RELEASE, COLLECTOR_VERSION
from work_guard import ACTIVITY

PUBLISHER = "https://raw.githubusercontent.com/prepaid1215/nr-manage/main/v2/sync-client/installer/"
MANIFEST_URL = PUBLISHER + "version.json"
ARTIFACT_URL = PUBLISHER + "NRCSync.exe"
MAX_BYTES = 128 * 1024 * 1024
CHECK_SECONDS = 30 * 60
CREATE_HIDDEN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_instance_handle = None


def take_instance_lock():
    global _instance_handle
    if os.name != "nt":
        return True
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    kernel.CreateMutexW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    name = "Local\\NRCSync-" + hashlib.sha256(str(install_root().resolve()).lower().encode()).hexdigest()[:16]
    handle = kernel.CreateMutexW(None, True, name)
    if not handle:
        raise OSError("NRC Sync 실행 상태를 확인하지 못했습니다.")
    if ctypes.get_last_error() == 183:
        kernel.CloseHandle(handle)
        return False
    _instance_handle = handle
    return True


def install_root():
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "NRCSync"


def atomic_json(path, data):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def read_json(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def validate_manifest(value):
    if isinstance(value, dict) and value.get("disabled") is True:
        return {"disabled": True}
    if not isinstance(value, dict) or value.get("schema") != 1:
        raise ValueError("지원하지 않는 업데이트 정보입니다.")
    if type(value.get("release")) is not int or not 1 <= value["release"] <= 999999999999:
        raise ValueError("잘못된 업데이트 버전입니다.")
    if type(value.get("bytes")) is not int or not 256 <= value["bytes"] <= MAX_BYTES:
        raise ValueError("잘못된 업데이트 파일 크기입니다.")
    if not isinstance(value.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"]):
        raise ValueError("업데이트 파일 검증 정보가 없습니다.")
    if not isinstance(value.get("collectorVersion"), str) or not re.fullmatch(r"[a-zA-Z0-9._-]{1,80}", value["collectorVersion"]):
        raise ValueError("잘못된 수집기 버전입니다.")
    return value


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def verify_artifact(path, manifest):
    if path.is_symlink() or path.stat().st_size != manifest["bytes"] or digest(path) != manifest["sha256"]:
        raise ValueError("업데이트 파일의 크기 또는 해시가 일치하지 않습니다.")
    with path.open("rb") as source:
        header = source.read(64)
        if len(header) != 64 or header[:2] != b"MZ":
            raise ValueError("Windows 실행 파일이 아닙니다.")
        pe_offset = struct.unpack_from("<I", header, 60)[0]
        if pe_offset > manifest["bytes"] - 6:
            raise ValueError("실행 파일 헤더가 손상되었습니다.")
        source.seek(pe_offset)
        if source.read(6) != b"PE\x00\x00\x64\x86":
            raise ValueError("지원하지 않는 실행 파일입니다.")


def open_publisher(url):
    # Update URLs are fixed in code; manifests cannot redirect the program to another publisher.
    if url not in (MANIFEST_URL, ARTIFACT_URL):
        raise ValueError("허용되지 않은 업데이트 주소입니다.")
    response = urllib.request.urlopen(urllib.request.Request(url, headers={
        "User-Agent": "NRCSync/" + COLLECTOR_VERSION,
        "Cache-Control": "no-cache",
    }), timeout=20)
    if response.geturl().split("?", 1)[0] != url:
        response.close()
        raise ValueError("업데이트 다운로드 주소가 변경되었습니다.")
    return response


def fetch_manifest(opener=open_publisher):
    with opener(MANIFEST_URL) as response:
        data = response.read(16385)
        if len(data) > 16384:
            raise ValueError("업데이트 정보가 너무 큽니다.")
        return validate_manifest(json.loads(data))


def download_artifact(manifest, destination, opener=open_publisher):
    partial = destination.with_suffix(".part")
    deadline = time.monotonic() + 300
    try:
        with opener(ARTIFACT_URL) as response, partial.open("wb") as output:
            announced = response.headers.get("Content-Length")
            if announced is not None and int(announced) != manifest["bytes"]:
                raise ValueError("다운로드 파일 크기가 변경되었습니다.")
            size = 0
            while True:
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > manifest["bytes"] or time.monotonic() > deadline:
                    raise ValueError("다운로드 크기 또는 시간 제한을 초과했습니다.")
                output.write(chunk)
        verify_artifact(partial, manifest)
        os.replace(partial, destination)
    finally:
        partial.unlink(missing_ok=True)


def validate_plan(plan_path, root):
    root, plan_path = root.resolve(), plan_path.resolve()
    updates = root / "updates"
    if plan_path.parent != updates or not re.fullmatch(r"plan-[0-9a-f]{32}\.json", plan_path.name):
        raise ValueError("잘못된 업데이트 계획 경로입니다.")
    plan = read_json(plan_path)
    manifest = validate_manifest(plan.get("manifest"))
    if manifest.get("disabled"):
        raise ValueError("배포가 중단된 업데이트입니다.")
    if not isinstance(plan.get("stage"), str) or not re.fullmatch(r"stage-[0-9]+-[0-9a-f]{32}\.exe", plan["stage"]):
        raise ValueError("잘못된 업데이트 파일 경로입니다.")
    stage = updates / plan["stage"]
    if stage.resolve().parent != updates or stage.is_symlink() or (root / "NRCSync.exe").is_symlink():
        raise ValueError("업데이트 경로가 설치 폴더 밖을 가리킵니다.")
    if type(plan.get("oldPid")) is not int or plan["oldPid"] <= 0:
        raise ValueError("잘못된 실행 중 프로세스 정보입니다.")
    verify_artifact(stage, manifest)
    return plan, stage


def wait_process_exit(pid, timeout=120):
    if os.name != "nt":
        raise RuntimeError("자동 교체는 Windows에서만 지원됩니다.")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x00100000, False, pid)
    if not handle:
        if ctypes.get_last_error() == 87:  # already exited
            return True
        raise OSError("기존 프로그램의 종료 상태를 확인하지 못했습니다.")
    try:
        return kernel.WaitForSingleObject(handle, int(timeout * 1000)) == 0
    finally:
        kernel.CloseHandle(handle)


def replace_when_unlocked(source, target, timeout=30):
    deadline = time.monotonic() + timeout
    while True:
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.5)


def launch_program(target, token):
    return subprocess.Popen([str(target), "--updated-token", token], cwd=str(target.parent), creationflags=CREATE_HIDDEN)


def stop_launched_process(process):
    if process is not None and process.poll() is None:
        # Only the exact process tree started by this helper, never another running NRC Sync.
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15,
                       creationflags=CREATE_HIDDEN, check=False)
        process.wait(timeout=15)


def wait_health(release, token, process, timeout=180):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        try:
            with urllib.request.urlopen("http://127.0.0.1:5050/health", timeout=2) as response:
                data = json.loads(response.read(4096))
            if data.get("ok") and data.get("release") == release and data.get("startupToken") == token:
                return True
        except (OSError, ValueError):
            pass
        time.sleep(1)
    return False


def apply_update(plan_path, root, wait_exit=wait_process_exit, launch=launch_program,
                 health=wait_health, stop=stop_launched_process):
    plan, stage = validate_plan(plan_path, root)
    root = root.resolve()
    updates = root / "updates"
    target, backup = root / "NRCSync.exe", updates / "last-good.exe"
    state_path = updates / "state.json"
    ready = plan_path.with_suffix(".ready.json")
    atomic_json(ready, {"ready": True})
    if not wait_exit(plan["oldPid"]):
        atomic_json(state_path, {"status": "error", "message": "기존 프로그램이 종료되지 않아 업데이트를 취소했습니다."})
        ready.unlink(missing_ok=True)
        plan_path.unlink(missing_ok=True)
        return False
    previous_moved, replacement_started = False, None
    try:
        verify_artifact(stage, plan["manifest"])
        replace_when_unlocked(target, backup)
        previous_moved = True
        replace_when_unlocked(stage, target)
        token = uuid.uuid4().hex
        replacement_started = launch(target, token)
        if not health(plan["manifest"]["release"], token, replacement_started):
            raise RuntimeError("새 프로그램의 정상 실행을 확인하지 못했습니다.")
        atomic_json(state_path, {"status": "updated", "release": plan["manifest"]["release"],
                                "message": "업데이트를 완료했습니다.", "time": time.time()})
        return True
    except Exception:
        try:
            stop(replacement_started)
            if previous_moved and backup.exists():
                replace_when_unlocked(backup, target)
            launch(target, uuid.uuid4().hex)
            atomic_json(state_path, {"status": "rolled_back", "failedRelease": plan["manifest"]["release"],
                                    "failedAt": time.time(), "message": "업데이트에 실패해 이전 버전으로 복구했습니다."})
        except Exception:
            atomic_json(state_path, {"status": "restore_failed", "failedRelease": plan["manifest"]["release"],
                                    "failedAt": time.time(), "message": "자동 복구를 완료하지 못했습니다. NRC Sync를 다시 실행해 주세요."})
        return False
    finally:
        ready.unlink(missing_ok=True)
        plan_path.unlink(missing_ok=True)


def helper_main(plan_path):
    try:
        return 0 if apply_update(Path(plan_path), install_root()) else 1
    except Exception:
        # Invalid plans must not modify or launch anything.
        return 2


class UpdateManager:
    def __init__(self, root=None, executable=None, frozen=None, gate=ACTIVITY,
                 fetch=fetch_manifest, download=download_artifact):
        self.root = (root or install_root()).resolve()
        self.executable = Path(executable or sys.executable).resolve()
        self.frozen = getattr(sys, "frozen", False) if frozen is None else frozen
        self.gate, self.fetch, self.download = gate, fetch, download
        self._wake = threading.Event()
        self._status = {"status": "idle", "currentRelease": APP_RELEASE, "currentVersion": COLLECTOR_VERSION}
        self._lock = threading.Lock()

    def enabled(self):
        target = self.root / "NRCSync.exe"
        try:
            return self.frozen and target.is_file() and (
                self.executable == target.resolve() or digest(self.executable) == digest(target))
        except OSError:
            return False

    def snapshot(self):
        with self._lock:
            return {**self._status, "enabled": self.enabled(), "activeTasks": self.gate.active}

    def status(self, state, message, **values):
        with self._lock:
            self._status.update(status=state, message=message, **values)

    def wake(self):
        self._wake.set()

    def check_once(self, handoff=None):
        if not self.enabled():
            self.status("not_installed", "이 PC 자동 등록 후 자동 업데이트를 사용할 수 있습니다.")
            return False
        updates = self.root / "updates"
        updates.mkdir(exist_ok=True)
        self.status("checking", "새 버전을 확인하는 중입니다.", lastChecked=time.time())
        manifest = validate_manifest(self.fetch())
        if manifest.get("disabled"):
            self.status("paused", "수집기 배포를 점검 중입니다. 현재 버전을 유지합니다.")
            return False
        if manifest["release"] <= APP_RELEASE:
            self.status("current", "최신 버전입니다.")
            return False
        prior = read_json(updates / "state.json")
        if prior.get("failedRelease") == manifest["release"] and time.time() - prior.get("failedAt", 0) < 86400:
            self.status("deferred", "실패한 버전의 재시도를 미뤘습니다. 기존 버전으로 계속 실행합니다.")
            return False
        identifier = uuid.uuid4().hex
        stage = updates / f"stage-{manifest['release']}-{identifier}.exe"
        self.status("downloading", "새 버전을 다운로드하는 중입니다.", latestVersion=manifest["collectorVersion"])
        try:
            self.download(manifest, stage)
            verify_artifact(stage, manifest)
        except Exception:
            stage.unlink(missing_ok=True)
            raise
        self.status("waiting", "수집 또는 메모장 작업이 끝나면 업데이트합니다.")
        if not self.gate.pause():
            stage.unlink(missing_ok=True)
            self.status("deferred", "실행 중인 작업이 있어 다음에 업데이트합니다.")
            return False
        try:
            self.status("applying", "업데이트를 적용하는 중입니다.")
            if handoff is not None:
                return handoff(stage, manifest)
            helper = updates / f"helper-{identifier}.exe"
            shutil.copy2(self.executable, helper)
            plan_path = updates / f"plan-{identifier}.json"
            atomic_json(plan_path, {"stage": stage.name, "manifest": manifest, "oldPid": os.getpid()})
            process = subprocess.Popen([str(helper), "--apply-update", str(plan_path)],
                                       cwd=str(self.root), creationflags=CREATE_HIDDEN)
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline and process.poll() is None:
                if read_json(plan_path.with_suffix(".ready.json")).get("ready"):
                    os._exit(0)
                time.sleep(0.25)
            # Never abandon a helper that could replace the target after the old process exits later.
            stop_launched_process(process)
            plan_path.unlink(missing_ok=True)
            raise RuntimeError("업데이트 도우미를 시작하지 못했습니다.")
        finally:
            self.gate.resume()

    def cleanup(self):
        updates = self.root / "updates"
        if not updates.is_dir():
            return
        for path in updates.iterdir():
            if re.fullmatch(r"(?:helper-[0-9a-f]{32}\.exe|stage-[0-9]+-[0-9a-f]{32}\.(?:exe|part)|plan-[0-9a-f]{32}(?:\.ready)?\.json)", path.name):
                if time.time() - path.stat().st_mtime > 86400:
                    try:
                        path.unlink()
                    except OSError:
                        pass

    def start(self, initial_delay=15):
        def loop():
            self._wake.wait(initial_delay)
            while True:
                self._wake.clear()
                try:
                    self.cleanup()
                    self.check_once()
                except Exception:
                    self.status("error", "업데이트를 확인하지 못했습니다. 기존 버전으로 계속 실행합니다.")
                self._wake.wait(CHECK_SECONDS)
        threading.Thread(target=loop, daemon=True, name="nrc-auto-update").start()
