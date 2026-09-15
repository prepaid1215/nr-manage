"""네이버 모바일 검색에서 내 블로그 글이 특정 키워드로 몇 번째쯤 노출되는지 확인한다.

naver_login.py가 저장한 로그인 쿠키를 그대로 쓴다(재로그인 없음). 로그인 세션을 쓰는
이유는 개인화 검색 결과가 아니라, 이 PC에서 이미 로그인된 네이버 계정 흐름을 그대로
재사용하기 위함이다.
"""

import random
import re
import time
from urllib.parse import parse_qs, quote, urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

import naver_login

MAX_SCROLL = 6


def sleep_random(a=0.9, b=2.0):
    time.sleep(random.uniform(a, b))


def is_blog_post_url(url):
    parsed = urlparse(url)
    if parsed.netloc.lower() not in {"blog.naver.com", "m.blog.naver.com"}:
        return False
    if "PostView.naver" in parsed.path:
        qs = parse_qs(parsed.query)
        return bool(qs.get("blogId") and qs.get("logNo"))
    parts = [p for p in parsed.path.split("/") if p]
    return len(parts) >= 2 and parts[1].isdigit()


def blog_id_of(url):
    parsed = urlparse(url)
    parts = [p for p in parsed.path.split("/") if p]
    if "PostView.naver" in parsed.path:
        return parse_qs(parsed.query).get("blogId", [""])[0].lower()
    if len(parts) >= 1:
        return parts[0].lower()
    return ""


def collect_blog_links(page):
    links = []
    for element in page.locator("a[href]").all():
        try:
            href = element.get_attribute("href") or ""
            text = element.inner_text(timeout=800).strip()
        except PlaywrightTimeoutError:
            continue
        except Exception:
            continue
        if href and is_blog_post_url(href):
            links.append({"title": re.sub(r"\s+", " ", text)[:150], "url": href})
    return links


def find_my_blog(page, blog_id, max_scroll, stage):
    seen_urls = set()
    seen_count = 0
    for scroll_no in range(1, max_scroll + 1):
        for item in collect_blog_links(page):
            if item["url"] in seen_urls:
                continue
            seen_urls.add(item["url"])
            seen_count += 1
            if blog_id_of(item["url"]) == blog_id.lower():
                return {"stage": stage, "rank": seen_count, "scroll": scroll_no, "title": item["title"], "url": item["url"]}
        page.mouse.wheel(0, random.randint(450, 1600))
        page.evaluate("window.scrollBy(0, Math.floor(window.innerHeight * 0.8))")
        sleep_random()
    return None


def check_keyword(label, blog_id, keyword, max_scroll=MAX_SCROLL):
    """키워드로 검색해 통합검색/블로그탭에서 blog_id 글이 노출되는 위치를 찾는다."""
    session_file = naver_login.session_path(label)
    if not session_file.exists():
        raise RuntimeError(f'"{label}" 계정이 아직 로그인되어 있지 않습니다. 먼저 로그인해 주세요.')

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        iphone = p.devices["iPhone 13"]
        context = browser.new_context(storage_state=str(session_file), **iphone, locale="ko-KR", timezone_id="Asia/Seoul")
        page = context.new_page()

        page.goto("https://m.naver.com", wait_until="domcontentloaded", timeout=30000)
        sleep_random()
        try:
            box = page.locator("input[name='query'], input[type='search']").first
            box.click(timeout=3000)
            box.fill(keyword, timeout=3000)
            box.press("Enter", timeout=3000)
            page.wait_for_load_state("domcontentloaded", timeout=10000)
        except Exception:
            page.goto(f"https://m.search.naver.com/search.naver?query={quote(keyword)}", wait_until="domcontentloaded", timeout=30000)
        sleep_random()

        integrated = find_my_blog(page, blog_id, max_scroll, "integrated")

        tab_found = None
        try:
            page.evaluate("window.scrollTo(0, 0)")
            tab = page.locator("a[href*='where=m_blog'], a:has-text('블로그')").first
            tab.click(timeout=3000)
            page.wait_for_load_state("domcontentloaded", timeout=10000)
            sleep_random()
            tab_found = find_my_blog(page, blog_id, max_scroll, "blog_tab")
        except Exception:
            pass

        browser.close()
        return {"keyword": keyword, "integrated": integrated, "blog_tab": tab_found}
