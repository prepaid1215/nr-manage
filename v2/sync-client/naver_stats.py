"""네이버 블로그 관리자 통계 페이지에서 오늘 방문자수·조회수 등을 읽어온다.

naver_login.py가 저장해둔 로그인 쿠키(storage_state)를 그대로 재사용해
admin.blog.naver.com의 관리자 전용 통계 페이지에 접속한다. 새로 로그인하지 않는다.
"""

import re

from playwright.sync_api import sync_playwright

import naver_login

TODAY_LABELS = ["조회수", "동영상 재생수", "공감수", "댓글수", "이웃증감수"]

EXTRACT_TODAY_JS = r"""
(labels) => {
  const result = {};
  for (const label of labels) {
    const el = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && e.textContent.trim() === label
    );
    if (!el) { result[label] = null; continue; }
    let node = el.parentElement;
    let text = '';
    for (let i = 0; i < 3 && node; i++) {
      text = node.textContent || '';
      if (text.replace(label, '').match(/[0-9][0-9,]*/)) break;
      node = node.parentElement;
    }
    const match = text.replace(label, '').match(/[0-9][0-9,]*/);
    result[label] = match ? match[0] : null;
  }
  return result;
}
"""


def _open_page(label, path):
    """저장된 세션으로 admin.blog.naver.com의 지정 경로를 연다."""
    session_file = naver_login.session_path(label)
    if not session_file.exists():
        raise RuntimeError(f'"{label}" 계정이 아직 로그인되어 있지 않습니다. 먼저 로그인해 주세요.')
    return session_file


def fetch_today(label, blog_id):
    """오늘 현황(조회수/동영상재생수/공감수/댓글수/이웃증감수)을 읽어온다."""
    session_file = _open_page(label, "stat/today")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(storage_state=str(session_file))
        page = context.new_page()
        page.goto(f"https://admin.blog.naver.com/{blog_id}/stat/today", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(1200)
        data = page.evaluate(EXTRACT_TODAY_JS, TODAY_LABELS)
        browser.close()
        return data


def fetch_visitors(label, blog_id):
    """오늘 순방문자수를 읽어온다."""
    session_file = _open_page(label, "stat/uv")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(storage_state=str(session_file))
        page = context.new_page()
        page.goto(f"https://admin.blog.naver.com/{blog_id}/stat/uv", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(1200)
        body_text = page.inner_text("body")
        browser.close()
        match = re.search(r"순방문자수[\s\S]{0,80}?([0-9][0-9,]*)\s*명", body_text)
        return {"순방문자수": match.group(1) if match else None}
