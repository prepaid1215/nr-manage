"""Render actual organization UI against full, legacy and partial snapshots; no production data."""
import json
import logging
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'cloud-worker/tests'))
import browser_account_recovery as fixture


def run():
    original = fixture.STUB
    server = make_server('127.0.0.1', 0, fixture.app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'
    cases = [
        ('complete', dict(lineMetricsVersion=2, lineMetricsFound=True, consumerTotalLines=5,
                         realLines=5, ownSalesLines=0, regularDeliveryLines=0,
                         lineMetricsAvailable=dict(consumerTotalLines=True, realLines=True, ownSalesLines=True, regularDeliveryLines=True)), '5회선', '0회선'),
        ('legacy', dict(lineMetricsFound=True, consumerTotalLines=5, realLines=0, ownSalesLines=0, regularDeliveryLines=0), '미수집', '미수집'),
        ('partial', dict(lineMetricsVersion=2, lineMetricsFound=True, consumerTotalLines=5,
                        realLines=None, ownSalesLines=None, regularDeliveryLines=None,
                        lineMetricsAvailable=dict(consumerTotalLines=True)), '미수집', '미수집'),
    ]
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='msedge', headless=True)
            for name, metrics, real, own in cases:
                snapshot = dict(source_account_id='member01', collected_at='2026-11-08T07:00:00Z', payload={
                    'rstLst': [dict(userId='2913195', userName='검증회원', ppId='', lv=0, status='1')],
                    'members': [dict(userId='2913195', ordPv=8100, maxPv=120690, minPv=16200, **metrics)],
                })
                # Each method in the real query chain returns this same proxy.
                replacement = '''from: table => {
                  let proxy = new Proxy({}, {get(target,key) {
                    if(key==='then') return (resolve,reject)=>Promise.resolve({data:table==='nrc_sync_snapshots'?SNAPSHOT:[],error:null}).then(resolve,reject);
                    return ()=>proxy;
                  }}); return proxy;
                },'''.replace('SNAPSHOT', json.dumps(snapshot, ensure_ascii=False))
                fixture.STUB = original.replace('from: () => chain,', replacement)
                page = browser.new_page(viewport={'width':1200,'height':900}, service_workers='block')
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.route('https://**/*', lambda route: route.abort())
                page.goto(base)
                page.locator('#loginUsername').fill('member01')
                page.locator('#loginPassword').fill('Current!123')
                page.locator('#authSubmit').click()
                page.locator('#appView').wait_for(state='visible')
                page.locator('#topNav [data-page="organization"]').click()
                page.locator('#memberDetailInline table').wait_for()
                rows = page.locator('#memberDetailInline tr').all_text_contents()
                line_row = next(row for row in rows if '소비자 총회선' in row)
                own_row = next(row for row in rows if '본인 매출 회선' in row)
                assert '5회선' in line_row and real in line_row, line_row
                assert own in own_row, own_row
                if name == 'legacy':
                    assert 'NRC Sync 최신 버전' in page.locator('#memberDetailInline').inner_text()
                    assert '0회선' not in line_row
                assert not errors, errors
                page.close()
                print(f'Organization browser check passed: {name}.')
            browser.close()
    finally:
        fixture.STUB = original
        server.shutdown()


if __name__ == '__main__':
    logging.getLogger('werkzeug').setLevel(logging.ERROR)
    run()
