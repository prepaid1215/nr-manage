"""Safety-gated migration from the legacy NRC-Sync-Desktop Python server.

Only the specific *listening* legacy Python server may be stopped, after a
visible user confirmation. Unknown processes and other Python programs are
never stopped. This module uses only the Python standard library.
"""
import ctypes
import json
import os
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path

PORT = 5050
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_LEGACY_SCRIPT = re.compile(r"(?i)[\\/]NRC-Sync-Desktop[\\/]api\.py(?=[\s\"']|$)")


def legacy_command(command):
    """Recognize a path to the exact old NRC desktop entry point."""
    return bool(_LEGACY_SCRIPT.search(str(command or "")))


def port_available():
    """Probe the same IPv4 address Flask will bind; no HTTP credentials used."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", PORT))
            return True
    except OSError:
        return False


def _powershell(script):
    run = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, timeout=12, creationflags=_NO_WINDOW,
    )
    if run.returncode:
        raise RuntimeError("Windows 프로세스 검사 실패")
    return run.stdout.decode("utf-8-sig", errors="replace").strip()


def find_port_owners():
    """Return the holders of IPv4 127.0.0.1:5050, with their command lines.

    Never choose an arbitrary first connection: multiple local listeners can
    coexist on different addresses. Failure to identify is a hard stop.
    """
    script = r'''
$ErrorActionPreference = 'Stop'
$owners = @(Get-NetTCPConnection -LocalPort 5050 -State Listen |
  Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0') } |
  Select-Object -ExpandProperty OwningProcess -Unique)
$result = @(
  foreach ($ownerPid in $owners) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid"
    if ($null -ne $p) {
      $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwner
      [pscustomobject]@{
        pid = [int]$p.ProcessId
        name = [string]$p.Name
        command = [string]$p.CommandLine
        user = [string]$owner.User
      }
    }
  }
)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -InputObject $result -Compress -Depth 3
'''
    output = _powershell(script)
    result = json.loads(output) if output else []
    if isinstance(result, dict):
        result = [result]
    if not isinstance(result, list):
        raise ValueError("잘못된 프로세스 검사 결과")
    return result


def is_verified_legacy(info, username=None):
    name = str(info.get("name") or "").casefold()
    owner = str(info.get("user") or "").casefold()
    expected = (username if username is not None else os.environ.get("USERNAME", "")).casefold()
    pid = info.get("pid")
    return (
        name in ("python.exe", "pythonw.exe")
        and isinstance(pid, int) and pid > 0
        and bool(expected) and owner == expected
        and legacy_command(info.get("command"))
    )


def _message(body, question=False):
    if os.name != "nt":
        return False
    flags = (0x04 if question else 0x00) | 0x30 | 0x00040000
    result = ctypes.windll.user32.MessageBoxW(
        None, body, "NRC Sync 버전 전환", flags,
    )
    return result == 6 if question else False


def stop_legacy_process(info):
    """Re-check PID *and* executable identity immediately before termination."""
    matches = [item for item in find_port_owners() if item.get("pid") == info["pid"]]
    if len(matches) != 1 or matches[0] != info or not is_verified_legacy(matches[0]):
        raise RuntimeError("구버전 프로세스가 변경돼 안전을 위해 중단했습니다.")
    result = subprocess.run(
        ["taskkill.exe", "/PID", str(info["pid"]), "/T", "/F"],
        capture_output=True, timeout=10, creationflags=_NO_WINDOW,
    )
    if result.returncode:
        raise RuntimeError("구버전 프로그램을 종료하지 못했습니다.")


def disable_known_legacy_startups():
    """Back up and disable ONLY startup scripts / HKCU Run commands that name api.py.

    Other entries, shortcuts and scheduled tasks remain untouched. A future
    legacy launcher we cannot verify will be reported as an unresolved case.
    """
    base = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "NRCSync" / "legacy-startup-backup"
    disabled = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        startup = Path(appdata) / "Microsoft/Windows/Start Menu/Programs/Startup"
        if startup.is_dir():
            for item in startup.iterdir():
                if (not item.is_file() or item.suffix.lower() not in
                        {".vbs", ".cmd", ".bat", ".ps1"} or item.stat().st_size > 65536):
                    continue
                try:
                    script_text = item.read_text(encoding="utf-8-sig")
                except (OSError, UnicodeError):
                    try:
                        script_text = item.read_text(encoding="cp949")
                    except (OSError, UnicodeError):
                        continue
                if not legacy_command(script_text):
                    continue
                base.mkdir(parents=True, exist_ok=True)
                backup = base / (item.name + ".disabled")
                if backup.exists():
                    backup = base / (item.name + "." + str(time.time_ns()) + ".disabled")
                shutil.move(str(item), str(backup))
                disabled.append("시작프로그램: " + item.name)

    if os.name == "nt":
        import winreg
        key_name = r"Software\Microsoft\Windows\CurrentVersion\Run"
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_name, 0,
                                 winreg.KEY_READ | winreg.KEY_SET_VALUE)
        except OSError:
            key = None
        if key is not None:
            with key:
                values = []
                index = 0
                while True:
                    try:
                        values.append(winreg.EnumValue(key, index))
                        index += 1
                    except OSError:
                        break
                matches = [(name, val, kind) for name, val, kind in values
                           if isinstance(val, str) and legacy_command(val)]
                if matches:
                    base.mkdir(parents=True, exist_ok=True)
                    backup = base / ("hkcu-run-" + str(time.time_ns()) + ".json")
                    backup.write_text(json.dumps(matches, ensure_ascii=False, indent=2),
                                      encoding="utf-8")
                    for name, _, _ in matches:
                        winreg.DeleteValue(key, name)
                        disabled.append("자동 시작 레지스트리: " + name)
    return disabled


def ensure_local_port_ready():
    """Prevent silent Flask bind errors; offer an opt-in legacy handoff."""
    if port_available():
        return True
    try:
        owners = find_port_owners()
        if not owners or not all(is_verified_legacy(item) for item in owners):
            _message(
                "5050 포트를 다른 프로그램이 사용 중입니다.\n"
                "NRC Sync가 실행되지 않았습니다.\n\n"
                "기존 프로그램을 종료하거나 관리자에게 문의하세요."
            )
            return False
        if not _message(
            "이전 NRC Sync (NRC-Sync-Desktop)가 실행 중입니다.\n\n"
            "현재 진행 중인 수집이 있다면 중단됩니다.\n"
            "먼저 수집이 끝났는지 확인하세요.\n\n"
            "구버전을 종료하고 최신 NRC Sync로 전환하시겠습니까?\n"
            "(알려진 구버전 자동 시작 항목은 백업 후 비활성화합니다.)",
            question=True,
        ):
            return False
        for info in owners:
            stop_legacy_process(info)
        for _ in range(32):
            if port_available():
                break
            time.sleep(0.25)
        else:
            raise RuntimeError("기존 프로그램이 5050 포트를 해제하지 않았습니다.")
        try:
            disable_known_legacy_startups()
        except (OSError, ValueError) as exc:
            # A failed startup cleanup must never prevent a working new collector.
            print("NRC legacy startup cleanup warning:", str(exc))
        return True
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print("NRC legacy port recovery:", str(exc))
        _message("이전 NRC Sync에서 전환하지 못했습니다.\n"
                 "다른 프로그램은 종료하지 않았습니다.\n\n"
                 "관리자에게 5050 포트 충돌을 알려주세요.")
        return False
