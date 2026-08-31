"""이 PC에 영구 설치할지, 잠깐 쓰고 흔적 없이 끝낼지(임시 연결) 판단한다.

실행파일 이름에 "temp"가 들어있거나 --temp 인자를 주면 임시 모드로 켜진다.
임시 모드에서는 %LOCALAPPDATA%에 설치되지 않고, Windows 시작 프로그램에도
등록되지 않으며, 등록한 PC 정보는 프로그램을 끄면 서버에서도 지워진다.
"""

import sys
from pathlib import Path


def _detect_temp_mode():
    if "--temp" in sys.argv:
        return True
    if getattr(sys, "frozen", False):
        return "temp" in Path(sys.executable).stem.lower()
    return False


TEMP_MODE = _detect_temp_mode()
