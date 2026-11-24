"""검색 버튼(goSearch) 방식 수동 시험. 한 회원만 조회해 결과를 출력한다.

사용: python tests/manual_member_search.py <회원번호> [이름] [직급] [마감차수 정산기준일]
예:   python tests/manual_member_search.py 913195 김정경 GD
NRC 계정은 v2/sync-client/.env 의 NRC_USER_ID / NRC_USER_PW 를 사용한다. 값은 출력하지 않는다.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright
import scraper


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    user_id = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else ""
    rank_cd = scraper.RANK_NAME_TO_CD.get(sys.argv[3] if len(sys.argv) > 3 else "GD", "25")
    pay_date = sys.argv[4] if len(sys.argv) > 4 else None
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page()
        try:
            scraper.login(page)
            scraper.open_page(page, "/myofficePlus/os/2/member/osFolderTree")
            view = scraper.scrape_member_by_search(page, user_id, name, rank_cd, pay_date)
            print(json.dumps(view, ensure_ascii=False, indent=2))
            if view is None:
                print("조회 결과가 없거나 회원번호가 일치하지 않습니다.")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
