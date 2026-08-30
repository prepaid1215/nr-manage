"""
NRC 마이오피스 데이터 수집기
- 소비자 회선현황: 매일 자동 수집
- 본인매출내역: 버튼 클릭 시 수집
"""

import sys
import os
import json
import re
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

# Windows 콘솔 UTF-8 출력
if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

load_dotenv()

BASE_URL = "https://www.nrcom.com:447"
USER_ID = os.getenv("NRC_USER_ID")
USER_PW = os.getenv("NRC_USER_PW")
DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)
NAVIGATION_TIMEOUT_MS = int(os.getenv("NRC_NAVIGATION_TIMEOUT_MS", "90000"))


def wait_for_page(page, timeout=12000):
    """동적 리소스가 계속 연결된 NRC 페이지에서도 본문 로드를 우선합니다."""
    try:
        page.wait_for_load_state("networkidle", timeout=timeout)
    except Exception:
        # NRC 페이지는 광고/알림 리소스가 연결된 채로 남을 수 있다.
        page.wait_for_load_state("domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)


def open_page(page, path):
    page.goto(
        f"{BASE_URL}{path}",
        wait_until="domcontentloaded",
        timeout=NAVIGATION_TIMEOUT_MS,
    )
    wait_for_page(page)


def save_json(filename, data):
    path = DATA_DIR / filename
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"💾 저장 완료: {path}")
    return path


def login(page):
    print("🔐 로그인 중...")
    open_page(page, "/myofficePlus/os/2/user/osLogin")

    page.fill('input[type="text"]', USER_ID)
    page.fill('input[type="password"]', USER_PW)
    page.click('a[href="javascript:go_loginProc();"]')

    try:
        page.wait_for_url(f"**osMain**", timeout=15000)
        print("✅ 로그인 성공")
    except Exception:
        # 비밀번호 변경 페이지로 리다이렉트되는 경우 처리
        if "osPassWdChange" in page.url:
            open_page(page, "/myofficePlus/os/2/main/osMain")
            print("✅ 로그인 성공 (비번변경 페이지 우회)")
        else:
            raise Exception(f"로그인 실패. 현재 URL: {page.url}")


def parse_table(html, headers):
    soup = BeautifulSoup(html, "html.parser")
    rows = []
    for tr in soup.select("table tbody tr, table tr"):
        cells = [td.get_text(strip=True) for td in tr.select("td")]
        if len(cells) >= len(headers):
            row = dict(zip(headers, cells[:len(headers)]))
            rows.append(row)
    return rows


def scrape_consumer_lines(page):
    print("📱 소비자 회선현황 수집 중...")
    open_page(page, "/myofficePlus/os/2/mybiz/osLinePresent")

    html = page.content()
    soup = BeautifulSoup(html, "html.parser")

    result = {
        "수집일시": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "KT망": [],
        "LG망": []
    }

    tables = soup.select("table")

    # KT망 테이블 파싱
    kt_headers = ["회원번호", "구분", "전화번호", "소비자이름", "등록일자", "잔액", "요금제", "회선상태", "내용", "장려금설정", "장려금설정일자"]
    # LG망 테이블 파싱 (유효기간 컬럼 추가)
    lg_headers = ["회원번호", "구분", "전화번호", "소비자이름", "등록일자", "잔액", "유효기간", "요금제", "회선상태", "내용", "장려금설정", "장려금설정일자"]

    for i, table in enumerate(tables):
        rows = []
        for tr in table.select("tbody tr, tr"):
            cells = [td.get_text(strip=True) for td in tr.select("td")]
            if not cells or len(cells) < 5:
                continue

            # KT망 vs LG망 구분
            망_type = None
            for cell in cells:
                if "K망" in cell:
                    망_type = "KT"
                    break
                elif "L망" in cell:
                    망_type = "LG"
                    break

            if 망_type == "KT" and len(cells) >= len(kt_headers):
                rows.append(dict(zip(kt_headers, cells[:len(kt_headers)])))
            elif 망_type == "LG" and len(cells) >= len(lg_headers):
                rows.append(dict(zip(lg_headers, cells[:len(lg_headers)])))

        if rows:
            if rows[0].get("구분", "").startswith("K"):
                result["KT망"].extend(rows)
            else:
                result["LG망"].extend(rows)

    total = len(result["KT망"]) + len(result["LG망"])
    print(f"  → KT망 {len(result['KT망'])}건, LG망 {len(result['LG망'])}건 (총 {total}건)")

    save_json("consumer_lines.json", result)
    return result


def scrape_sales(page, period="당월"):
    """
    period: '당월' | '전월' | '전체' | {'start': 'YYYY-MM-DD', 'end': 'YYYY-MM-DD'}
    """
    print(f"💰 본인매출내역 수집 중... ({period})")
    open_page(page, "/myofficePlus/os/2/order/osOrdProdSearch")

    # 기간 버튼 클릭
    if period == "당월":
        page.click("text=당월")
    elif period == "전월":
        page.click("text=전월")
    elif period == "전체":
        year = datetime.now().strftime("%Y")
        page.click(f"text={year}년 전체")
    elif isinstance(period, dict):
        # 커스텀 날짜: {'start': '2026-08-01', 'end': '2026-08-18'}
        start = period["start"].split("-")
        end = period["end"].split("-")
        page.select_option("select[name='schStrtYy'], select:nth-of-type(1)", start[0])
        page.select_option("select[name='schStrtMm'], select:nth-of-type(2)", start[1])
        page.select_option("select[name='schStrtDd'], select:nth-of-type(3)", start[2])
        page.select_option("select[name='schEndYy'], select:nth-of-type(4)", end[0])
        page.select_option("select[name='schEndMm'], select:nth-of-type(5)", end[1])
        page.select_option("select[name='schEndDd'], select:nth-of-type(6)", end[2])
        page.click("text=검색")

    wait_for_page(page)

    # 100건씩 표시
    try:
        page.select_option("select", "100")
        wait_for_page(page)
    except Exception:
        pass

    html = page.content()
    soup = BeautifulSoup(html, "html.parser")

    headers = ["접수일자", "상품명", "수량", "상품가격", "NV", "공제증권번호", "매출분류"]
    rows = []
    for tr in soup.select("table tbody tr, table tr"):
        cells = [td.get_text(strip=True) for td in tr.select("td")]
        if len(cells) >= 5 and re.match(r"\d{4}-\d{2}-\d{2}", cells[0]):
            rows.append(dict(zip(headers, cells[:len(headers)])))

    # 합계 행 찾기
    total_nv = 0
    for tr in soup.select("table tr"):
        if "합계" in tr.get_text():
            nums = re.findall(r"[\d,]+", tr.get_text())
            if nums:
                total_nv = int(nums[-1].replace(",", ""))
            break

    result = {
        "수집일시": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "기간": period if isinstance(period, str) else f"{period['start']} ~ {period['end']}",
        "총NV": total_nv,
        "건수": len(rows),
        "내역": rows
    }

    print(f"  → {len(rows)}건, 총 NV: {total_nv:,}")

    filename = f"sales_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    save_json(filename, result)
    save_json("sales_latest.json", result)  # 항상 최신 파일도 따로 저장
    return result


def scrape_main_stats(page):
    """메인 페이지의 실적 요약 (대실적, 소실적, 소비자 현황 총계)"""
    print("📊 메인 실적 요약 수집 중...")
    open_page(page, "/myofficePlus/os/2/main/osMain")

    html = page.content()
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text()

    result = {
        "수집일시": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }

    # 대실적/소실적 추출
    m = re.search(r"대실적\s*([\d,]+)", text)
    if m:
        result["대실적NV"] = int(m.group(1).replace(",", ""))

    m = re.search(r"소실적\s*([\d,]+)", text)
    if m:
        result["소실적NV"] = int(m.group(1).replace(",", ""))

    # 소비자 현황 총회선
    m = re.search(r"총회선\s*\((\d+)\s*/\s*(\d+)\)", text)
    if m:
        result["총회선"] = int(m.group(1))
        result["실인증회선"] = int(m.group(2))

    m = re.search(r"실회선\s*(\d+)", text)
    if m:
        result["실회선"] = int(m.group(1))

    # 직급
    m = re.search(r"현재직급\s*(\w+)", text)
    if m:
        result["현재직급"] = m.group(1)

    m = re.search(r"인증직급\s*(\w+)", text)
    if m:
        result["인증직급"] = m.group(1)

    print(f"  → 대실적: {result.get('대실적NV', 0):,} NV, 소실적: {result.get('소실적NV', 0):,} NV")

    save_json("main_stats.json", result)
    return result


def run_daily():
    """매일 자동 실행: 소비자현황 + 메인실적요약"""
    print(f"\n{'='*50}")
    print(f"🚀 일일 자동 수집 시작: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*50}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            login(page)
            scrape_main_stats(page)
            scrape_consumer_lines(page)
            print("✅ 일일 수집 완료")
        except Exception as e:
            print(f"❌ 오류 발생: {e}")
        finally:
            browser.close()


def run_sales_now(period="당월"):
    """매출내역 즉시 수집 (버튼 클릭 시 호출)"""
    print(f"\n{'='*50}")
    print(f"💰 매출내역 즉시 수집: {period}")
    print(f"{'='*50}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            login(page)
            result = scrape_sales(page, period)
            print("✅ 매출내역 수집 완료")
            return result
        except Exception as e:
            print(f"❌ 오류 발생: {e}")
            return None
        finally:
            browser.close()


RANK_CODE_MAP = {
    '01': '회원', '05': '회원', '10': '회원',
    '15': 'DT', '20': 'DT',
    '25': 'GD', '30': 'GD',
    '35': 'RD', '40': 'RD',
    '45': 'ED', '50': 'ED',
    '55': 'DD', '60': 'DD',
    '65': 'SDD', '70': 'SDD',
    '75': 'CDD', '80': 'CDD',
    '85': 'PM', '90': 'PM',
    '95': 'IM', '99': 'IM',
}

# rankName → rankCd (현재직급 기준 하위 코드 선택)
RANK_NAME_TO_CD = {
    '회원': '10', 'DT': '20', 'GD': '25', 'RD': '35',
    'ED': '45', 'DD': '55', 'SDD': '65', 'CDD': '75',
    'PM': '85', 'IM': '95',
}


def _post_json(page, path, form_data):
    """page 세션 쿠키를 사용한 인증 POST"""
    resp = page.request.post(f"{BASE_URL}{path}", form=form_data)
    return resp.json()


def _parse_genealogy_from_json(data) -> list:
    """
    osRankBoxFamTreeData.json 응답 → rstLst 변환
    응답 형식: {rstLst:[{userId,userName,rankCd,rankName,rankMaxName,ppId,rrId,abPos,regDate,status,...}]}
    또는 {rstSalesMap:[...]} 같은 다른 래퍼 형태일 수 있음
    """
    rows = None
    for key in ('rstLst', 'list', 'data', 'result'):
        val = data.get(key)
        if isinstance(val, list) and val:
            rows = val
            break
    if rows is None and isinstance(data, list):
        rows = data
    if not rows:
        return []

    rstLst = []
    for row in rows:
        uid_ = str(row.get('userId') or row.get('id') or '')
        if not uid_:
            continue
        rank_name = row.get('rankName') or RANK_CODE_MAP.get(str(row.get('rankCd', '')), '회원')
        lv = int(row.get('lv') or row.get('level') or row.get('depth') or 0)
        rstLst.append({
            'lv': lv,
            'userId': uid_,
            'userName': str(row.get('userName') or row.get('name') or ''),
            'rankName': rank_name,
            'rankMaxName': str(row.get('rankMaxName') or row.get('rankCertName') or rank_name),
            'regDate': str(row.get('regDate') or ''),
            'status': str(row.get('status') or '1'),
            'abPos': int(row.get('abPos') or row.get('pos') or 0),
            'ppId': str(row.get('ppId') or row.get('parentId') or ''),
            'rrId': str(row.get('rrId') or row.get('rootId') or uid_),
        })
    return rstLst


def _parse_genealogy_from_html(html: str) -> list:
    """계보도 HTML에서 계보 파싱 (폴백)"""
    click_pattern = re.compile(
        r"funcNameClick\('(\d+)','([^']+)','(\d+)','(\d+)','(\d+)','(\d+)'\)"
    )
    detail_pattern = re.compile(r"funcDetailSearch\('(\d+)','([^']+)'\)")

    click_rows = {}
    for m in click_pattern.finditer(html):
        uid_, uname, rcode, ppid, rrid, ssid = m.groups()
        click_rows[uid_] = {
            'userId': uid_, 'userName': uname,
            'rankCode': rcode, 'ppId': ppid, 'rrId': rrid,
        }

    all_detail = {}
    for m in detail_pattern.finditer(html):
        uid_, uname = m.groups()
        all_detail[uid_] = uname

    all_ids = list(all_detail.keys())
    child_ids = set(click_rows.keys())
    root_candidates = [i for i in all_ids if i not in child_ids]
    root_id = root_candidates[0] if root_candidates else (all_ids[0] if all_ids else None)
    if not root_id:
        return []

    parent_child_order: dict[str, list[str]] = {}
    for uid_, row in click_rows.items():
        ppid = row['ppId']
        parent_child_order.setdefault(ppid, []).append(uid_)

    level_map = {root_id: 0}
    queue = [root_id]
    while queue:
        cur = queue.pop(0)
        for child_id in parent_child_order.get(cur, []):
            level_map[child_id] = level_map[cur] + 1
            queue.append(child_id)

    rstLst = [{
        'lv': 0, 'userId': root_id, 'userName': all_detail.get(root_id, ''),
        'rankName': '회원', 'rankMaxName': '회원', 'regDate': '',
        'status': '1', 'abPos': 0, 'ppId': '', 'rrId': root_id,
    }]
    for uid_, row in click_rows.items():
        ppid = row['ppId']
        siblings = parent_child_order.get(ppid, [])
        abpos = siblings.index(uid_) + 1 if uid_ in siblings else 1
        rank_name = RANK_CODE_MAP.get(row['rankCode'], '회원')
        rstLst.append({
            'lv': level_map.get(uid_, 1), 'userId': uid_,
            'userName': row['userName'], 'rankName': rank_name,
            'rankMaxName': rank_name, 'regDate': '',
            'status': '1', 'abPos': abpos,
            'ppId': ppid, 'rrId': row['rrId'],
        })
    return rstLst


def extract_line_metrics(data):
    """회원별 매출 응답에 이미 포함된 회선 수를 키 이름 변형에 대응해 추출한다."""
    numbers = {}

    def walk(value, path=""):
        if isinstance(value, dict):
            for key, child in value.items():
                walk(child, f"{path}.{key}" if path else str(key))
        elif isinstance(value, (int, float)) or (isinstance(value, str) and re.fullmatch(r"[\d,]+", value.strip())):
            try:
                numbers[path] = int(str(value).replace(',', ''))
            except (ValueError, TypeError):
                pass

    walk(data)
    normalized = {re.sub(r'[^a-z0-9가-힣]', '', key.lower()): value for key, value in numbers.items()}

    def pick(aliases, required=(), preferred=()):
        for alias in aliases:
            alias_key = re.sub(r'[^a-z0-9가-힣]', '', alias.lower())
            for key, value in normalized.items():
                if key.endswith(alias_key):
                    return value
        matches = [(key, value) for key, value in normalized.items() if all(token in key for token in required)]
        if preferred:
            preferred_matches = [(key, value) for key, value in matches if any(token in key for token in preferred)]
            matches = preferred_matches
        return matches[0][1] if matches else None

    total = pick(
        ['consumerTotalLineCnt', 'consumerLineCnt', 'custTotalLineCnt', 'custLineCnt', 'cnsmrLineCnt', 'totalLineCnt', 'totLineCnt', 'consumerCnt'],
        required=('line',), preferred=('consumer', 'cust', 'cnsmr', 'total', 'tot')
    )
    real = pick(['realLineCnt', 'actualLineCnt', 'realCnt', '실회선'], required=('line',), preferred=('real', 'actual', '실'))
    own = pick(['ownSalesLineCnt', 'ownLineCnt', 'myLineCnt', 'ordLineCnt', '본인매출회선'], required=('line',), preferred=('own', 'my', 'ord', '본인'))
    delivery = pick(['regularDeliveryLineCnt', 'deliveryLineCnt', 'regularLineCnt', 'autoshipLineCnt', '정기배송회선'], required=('line',), preferred=('delivery', 'regular', 'autoship', '배송'))
    found = any(value is not None for value in (total, real, own, delivery))
    return {
        'lineMetricsFound': found,
        'consumerTotalLines': int(total or 0),
        'realLines': int(real or 0),
        'ownSalesLines': int(own or 0),
        'regularDeliveryLines': int(delivery or 0),
    }


def scrape_genealogy(page, depth=10):
    """
    계보도 수집 → rstLst 형식
    JSON API(osRankBoxFamTreeData.json) 우선, 실패시 HTML 파싱 폴백
    """
    print(f"🌳 계보도 수집 중... (표시단계={depth})")
    open_page(page, "/myofficePlus/os/2/member/osRankBoxFamTree")

    # ── JSON API 시도 ──────────────────────────────────────────────────────────
    try:
        pay_date = page.evaluate(
            '() => { var el = document.querySelector("#payDate"); return el ? el.value : ""; }'
        )
        if not pay_date:
            pay_date = datetime.now().strftime("%Y%m%d")

        json_data = _post_json(page, "/myofficePlus/os/member/osRankBoxFamTreeData.json", {
            "searchDepth": str(depth),
            "payDate": pay_date,
            "schGubun": "1",
        })
        rstLst = _parse_genealogy_from_json(json_data)
        if rstLst:
            print(f"  (JSON API) → 총 {len(rstLst)}명 계보 추출")
            return rstLst
        print("  JSON API 응답 비어있음, HTML 파싱으로 전환")
    except Exception as e:
        print(f"  JSON API 실패 ({e}), HTML 파싱으로 전환")

    # ── HTML 파싱 폴백 ─────────────────────────────────────────────────────────
    # schDepth는 readonly라서 JS로 강제 설정 → goSearch() 호출 (AJAX 방식)
    # wait_for_load_state("networkidle")만 사용하면 이미 idle인 페이지에서 즉시
    # 반환해, AJAX 결과가 DOM에 반영되기 전의 기본 5단계 HTML을 읽게 된다.
    before_node_count = page.evaluate("""() =>
        (document.body.innerHTML.match(/funcDetailSearch\\(/g) || []).length
    """)
    try:
        page.evaluate(f"""() => {{
            var el = document.getElementById('schDepth') || document.querySelector('[name="schDepth"]');
            if (el) {{ el.removeAttribute('readonly'); el.value = '{depth}'; }}
            if (typeof goSearch === 'function') goSearch();
        }}""")
        page.wait_for_function(
            """before =>
                (document.body.innerHTML.match(/funcDetailSearch\\(/g) || []).length > before
            """,
            arg=before_node_count,
            timeout=30000,
        )
    except Exception:
        # 실제 조직이 5단계 이하이면 노드 수가 늘지 않을 수 있다. 이 경우에도
        # 현재 DOM을 정상적인 결과로 사용한다.
        pass

    rstLst = _parse_genealogy_from_html(page.content())
    print(f"  (HTML 파싱) → 총 {len(rstLst)}명 계보 추출")
    return rstLst


def scrape_member_nv(page, rstLst, pay_date=None):
    """
    각 회원의 osPersonallySales.json 호출 → members NV 데이터 수집
    importCompanySales() 기대 형식:
    {userId, ordPv, maxPv, minPv, rankNewName, rankMaxName, dormant, status}
    schGubun=2: 확장프로그램과 동일한 방식 (하위 회원 조회용)
    """
    print("💹 회원별 NV 데이터 수집 중...")
    open_page(page, "/myofficePlus/os/2/member/osFolderTree")

    # 정산기준일 추출
    pay_date = pay_date or page.evaluate('() => { var el = document.querySelector("#payDate"); return el ? el.value : ""; }')
    if not pay_date:
        pay_date = datetime.now().strftime("%Y%m%d")
    print(f"  정산기준일: {pay_date}")

    root = rstLst[0] if rstLst else {}
    my_user_id = root.get('userId', USER_ID)
    my_rank_cd = RANK_NAME_TO_CD.get(root.get('rankName', '회원'), '25')

    def to_int(v):
        if v is None:
            return 0
        try:
            return int(str(v).replace(',', '') or '0')
        except (ValueError, TypeError):
            return 0

    members = []
    for row in rstLst:
        user_id = row['userId']
        rank_name = row.get('rankName', '회원')
        rank_cd = RANK_NAME_TO_CD.get(rank_name, '25')
        try:
            data = _post_json(page, "/myofficePlus/os/member/osPersonallySales.json", {
                "payDate": pay_date,
                "schRankCd": rank_cd,
                "schUserId": user_id,
                "schGubun": "2",
                "schRankCdTmp": "",
                "schUserIdTmp": "",
                "schPayDateTmp": "",
                "selectEndCnt": pay_date,
                "schUserName": row.get('userName', ''),
                "schUserId2": my_user_id,
                "schRankCd2": my_rank_cd,
            })
            sm = data.get('rstSalesMap') or {}
            line_metrics = extract_line_metrics(data)
            members.append({
                'userId': user_id,
                'ordPv': to_int(sm.get('ordPv')),
                'maxPv': to_int(sm.get('maxPv')),
                'minPv': to_int(sm.get('minPv')),
                'rankNewName': sm.get('rankNewName') or rank_name,
                'rankMaxName': sm.get('rankMaxName') or row.get('rankMaxName', rank_name),
                'dormant': row.get('status') == '2',
                'status': row.get('status', '1'),
                **line_metrics,
            })
        except Exception as e:
            print(f"    ⚠ {user_id} NV 조회 실패: {e}")
            members.append({
                'userId': user_id, 'ordPv': 0, 'maxPv': 0, 'minPv': 0,
                'rankNewName': rank_name,
                'rankMaxName': row.get('rankMaxName', rank_name),
                'dormant': False, 'status': row.get('status', '1'),
                'lineMetricsFound': False, 'consumerTotalLines': 0,
                'realLines': 0, 'ownSalesLines': 0, 'regularDeliveryLines': 0,
            })

    nv_found = sum(1 for m in members if m['maxPv'] > 0 or m['ordPv'] > 0)
    print(f"  → {len(members)}명 수집 완료 (유효 NV: {nv_found}명)")
    return members


def get_closing_periods(page, year, month, rounds=(1, 2, 3, 4)):
    """NRC 선택 목록에서 해당 연월의 마감차수와 정산기준일을 찾는다."""
    open_page(page, "/myofficePlus/os/2/member/osFolderTree")
    options = page.eval_on_selector_all(
        "#selectEndCnt option",
        "els => els.map(e => ({value: e.value, text: e.textContent.trim()}))",
    )
    wanted = set(int(r) for r in rounds)
    periods = []
    pattern = re.compile(rf"^{int(year)}년0?{int(month)}월([1-4])차$")
    for option in options:
        match = pattern.match(option.get("text", ""))
        if match and int(match.group(1)) in wanted:
            periods.append({"round": int(match.group(1)), "label": option["text"], "payDate": option["value"]})
    periods.sort(key=lambda item: item["round"])
    missing = sorted(wanted - {item["round"] for item in periods})
    if missing:
        raise ValueError(f"{year}년 {month}월 마감차수를 찾지 못했습니다: {missing}")
    return periods


def scrape_monthly_closings(page, year, month, rounds=(1, 2, 3, 4), depth=10):
    """한 달의 차수별 계보 NV를 한 파일로 저장한다."""
    print(f"📅 {year}년 {month}월 차수별 마감 수집 중...")
    rstLst = scrape_genealogy(page, depth=depth)
    if not rstLst:
        raise RuntimeError("계보 데이터가 없습니다.")
    periods = get_closing_periods(page, year, month, rounds)
    closings = []
    for period in periods:
        print(f"\n[{period['label']}] 정산기준일 {period['payDate']}")
        members = scrape_member_nv(page, rstLst, pay_date=period["payDate"])
        closings.append({**period, "members": members})
    result = {
        "createdAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "year": int(year), "month": int(month), "depth": int(depth),
        "rstLst": rstLst, "closings": closings,
    }
    filename = f"closings_{int(year):04d}_{int(month):02d}.json"
    save_json(filename, result)
    save_json("closings_latest.json", result)
    print(f"✅ {year}년 {month}월 {len(closings)}개 마감차수 저장 완료")
    return result


def run_closings(year, month, rounds=(1, 2, 3, 4), depth=10):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            login(page)
            return scrape_monthly_closings(page, year, month, rounds, depth)
        except Exception as e:
            print(f"❌ 마감차수 수집 오류: {e}")
            import traceback; traceback.print_exc()
            return None
        finally:
            browser.close()


def scrape_combined_json(page):
    """
    계보도 + NV 통합 JSON 생성
    NV 계보도 시뮬레이터의 '계보+NV 통합 JSON' 버튼으로 바로 불러올 수 있는 형식
    """
    print(f"\n{'='*50}")
    print(f"🔗 계보+NV 통합 JSON 생성 시작")
    print(f"{'='*50}")

    rstLst = scrape_genealogy(page)
    if not rstLst:
        print("❌ 계보 데이터 없음. 중단.")
        return None

    members = scrape_member_nv(page, rstLst)

    # 같은 로그인 세션에서 메인 소비자회선 총계와 KT/LG 목록도 함께 갱신한다.
    # 상세 회선은 PC에만 저장하고 Supabase 통합 JSON에는 집계값만 넣는다.
    main_stats = {}
    consumer_lines = {"KT망": [], "LG망": []}
    try:
        main_stats = scrape_main_stats(page) or {}
    except Exception as exc:
        print(f"⚠️ 메인 소비자회선 총계 수집 실패: {exc}")
    try:
        consumer_lines = scrape_consumer_lines(page) or consumer_lines
    except Exception as exc:
        print(f"⚠️ 소비자회선 목록 수집 실패: {exc}")

    consumer_by_member = {}
    genealogy_ids = [str(row.get('userId') or '') for row in rstLst]
    for network_key in ('KT망', 'LG망'):
        for line in consumer_lines.get(network_key, []):
            masked_member_no = str(line.get('회원번호') or '').strip()
            member_suffix = re.sub(r'\D', '', masked_member_no)
            if not member_suffix:
                continue
            matches = [user_id for user_id in genealogy_ids if user_id.endswith(member_suffix)]
            member_no = matches[0] if len(matches) == 1 else masked_member_no
            summary = consumer_by_member.setdefault(member_no, {'총회선': 0, 'KT망': 0, 'LG망': 0})
            summary['총회선'] += 1
            summary[network_key] += 1

    # NV 데이터의 실제 직급으로 rstLst 보정 (funcNameClick에 없는 루트 등)
    member_rank_map = {m['userId']: m for m in members}
    for r in rstLst:
        mv = member_rank_map.get(r['userId'])
        if mv:
            if r['rankName'] == '회원' and mv['rankNewName'] and mv['rankNewName'] != '회원':
                r['rankName'] = mv['rankNewName']
            if r['rankMaxName'] == '회원' and mv['rankMaxName'] and mv['rankMaxName'] != '회원':
                r['rankMaxName'] = mv['rankMaxName']

    combined = {
        'createdAt': datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        'sourceAccountId': USER_ID,
        'rstLst': rstLst,
        'members': members,
        'mainStats': main_stats,
        'consumerSummary': {
            '총회선': main_stats.get('총회선', len(consumer_lines.get('KT망', [])) + len(consumer_lines.get('LG망', []))),
            '실인증회선': main_stats.get('실인증회선', 0),
            '실회선': main_stats.get('실회선', 0),
            'KT망': len(consumer_lines.get('KT망', [])),
            'LG망': len(consumer_lines.get('LG망', [])),
        },
        'consumerByMember': consumer_by_member,
    }

    save_json("combined_latest.json", combined)
    print(f"\n✅ 통합 JSON 생성 완료")
    print(f"   계보: {len(rstLst)}명 / NV 데이터: {len(members)}명 / 소비자회선: {combined['consumerSummary']['총회선']}개")
    print(f"   → NV 계보도 시뮬레이터에서 '계보+NV 통합 JSON' 버튼으로 불러오세요")
    return combined


def run_combined():
    """계보+NV 통합 JSON 즉시 생성"""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            login(page)
            scrape_combined_json(page)
        except Exception as e:
            print(f"❌ 오류: {e}")
            import traceback; traceback.print_exc()
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "closings":
        now = datetime.now()
        year = int(sys.argv[2]) if len(sys.argv) > 2 else now.year
        month = int(sys.argv[3]) if len(sys.argv) > 3 else now.month
        rounds = tuple(int(x) for x in sys.argv[4].split(",")) if len(sys.argv) > 4 else (1, 2, 3, 4)
        run_closings(year, month, rounds)
    elif len(sys.argv) > 1 and sys.argv[1] == "sales":
        period = sys.argv[2] if len(sys.argv) > 2 else "당월"
        run_sales_now(period)
    elif len(sys.argv) > 1 and sys.argv[1] == "combined":
        run_combined()
    else:
        run_daily()
