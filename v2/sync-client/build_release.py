"""Build a candidate in an isolated environment; does not publish or execute the candidate."""
import hashlib
import importlib.metadata
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from sync_version import APP_RELEASE, COLLECTOR_VERSION
from auto_update import verify_artifact


def main():
    root = Path(__file__).resolve().parent
    output = root / 'build' / 'candidate'
    subprocess.run([
        sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--windowed',
        '--name', 'NRCSync', '--icon', str(root/'app_icon.ico'),
        '--add-data', str(root/'app_icon.ico') + ';.', '--collect-all', 'playwright',
        '--hidden-import', 'keyring.backends.Windows', '--hidden-import', 'pystray._win32',
        '--distpath', str(output), '--workpath', str(root/'build'/'release-work'),
        '--specpath', str(root/'build'), str(root/'api.py'),
    ], cwd=root, check=True)
    executable = output/'NRCSync.exe'
    manifest = dict(schema=1, release=APP_RELEASE, collectorVersion=COLLECTOR_VERSION,
                    builtAt=datetime.now(timezone.utc).isoformat(), bytes=executable.stat().st_size,
                    sha256=hashlib.sha256(executable.read_bytes()).hexdigest())
    verify_artifact(executable, manifest)
    (output/'version.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
    packages = sorted(f'{d.metadata["Name"]}=={d.version}' for d in importlib.metadata.distributions())
    (output/'build-packages.txt').write_text('\n'.join(packages)+'\n', encoding='utf-8')
    print(json.dumps({'candidate':str(executable), 'release':APP_RELEASE, 'sha256':manifest['sha256'],
                      'published':False, 'requiresDefenderScan':True}))


if __name__ == '__main__':
    main()
