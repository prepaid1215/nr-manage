"""네이버 블로그 계정 로그인 쿠키 저장.

로그인 창을 화면에 직접 띄워서(헤드리스 아님) 자동입력 방지문자나 새 기기
확인이 뜨면 사용자가 그 자리에서 직접 완료할 수 있게 한다. 로그인에 성공하면
쿠키(storage_state)를 이 PC의 로컬 파일에만 저장한다 — 클라우드나 다른 PC로
전송하지 않는다.
"""

import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

DATA_DIR = (
    Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "NRCSync" / "data"
    if getattr(sys, "frozen", False)
    else Path(__file__).parent / "data"
)
SESSIONS_DIR = DATA_DIR / "naver_sessions"
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

LOGIN_URL = "https://nid.naver.com/nidlogin.login"
LOGIN_WAIT_TIMEOUT_S = 180


def _safe_label(label):
    safe = "".join(c for c in str(label) if c.isalnum() or c in "-_")
    return safe or "account"


def session_path(label):
    return SESSIONS_DIR / f"{_safe_label(label)}.json"


def login_and_save_cookies(label, naver_id, password):
    """네이버 로그인을 시도하고 성공하면 쿠키를 이 PC에 저장한다.
    캡차 등으로 자동 입력이 막히면 사용자가 열린 창에서 직접 로그인을
    끝낼 수 있도록 최대 LOGIN_WAIT_TIMEOUT_S초까지 기다린다."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60000)
        try:
            id_field = page.locator("#id")
            id_field.click()
            id_field.press_sequentially(naver_id, delay=40)
            pw_field = page.locator("#pw")
            pw_field.click()
            pw_field.press_sequentially(password, delay=40)
            pw_field.press("Enter")
        except Exception:
            pass  # 자동 입력이 실패해도 창은 열려 있으니 사용자가 직접 입력하면 된다

        deadline = time.time() + LOGIN_WAIT_TIMEOUT_S
        logged_in = False
        while time.time() < deadline:
            cookies = context.cookies("https://www.naver.com")
            names = {c["name"] for c in cookies}
            if "NID_AUT" in names and "NID_SES" in names:
                logged_in = True
                break
            page.wait_for_timeout(1000)

        if logged_in:
            context.storage_state(path=str(session_path(label)))
        browser.close()
        if not logged_in:
            raise RuntimeError("로그인이 완료되지 않았습니다(시간 초과). 다시 시도해 주세요.")
        return str(session_path(label))


def list_sessions():
    return sorted(p.stem for p in SESSIONS_DIR.glob("*.json"))


def delete_session(label):
    session_path(label).unlink(missing_ok=True)
