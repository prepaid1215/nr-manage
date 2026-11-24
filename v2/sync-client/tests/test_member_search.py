import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scraper import parse_member_search_view, member_from_search_view

HTML = """
<table>
<tr><th>성명</th><td>김정경</td><th>회원번호</th><td>*913195</td></tr>
<tr><th>현재직급</th><td>GD</td><th>인증직급</th><td>GD</td></tr>
<tr><th>본인매출NV / DT그룹매출NV</th><td>0 / 0</td><th>정산 적용 NV</th><td>0</td></tr>
<tr><th>대실적(실시간)</th><td>0</td><th>소실적(실시간)</th><td>0</td></tr>
<tr><th>대실적</th><td>0</td><th>소실적</th><td>0</td></tr>
<tr><th>2마감 대실적</th><td>149,526</td><th>2마감 소실적</th><td>47,871</td></tr>
<tr><th>소비자 총 회선</th><td>4</td><th>실회선</th><td>4</td></tr>
<tr><th>본인 매출 회선</th><td>0</td><th>정기 배송 회선</th><td>0</td></tr>
</table>
"""


class MemberSearchViewTests(unittest.TestCase):
    def test_reads_labelled_values(self):
        view = parse_member_search_view(HTML)
        self.assertEqual(view['memberNo'], '*913195')
        self.assertEqual((view['ordPv'], view['groupPv']), (0, 0))
        self.assertEqual((view['maxPv'], view['minPv']), (0, 0))
        self.assertEqual((view['closingRound'], view['closingMaxPv'], view['closingMinPv']), (2, 149526, 47871))
        self.assertEqual((view['consumerTotalLines'], view['realLines']), (4, 4))

    def test_displayed_zero_is_present_and_missing_is_unknown(self):
        view = parse_member_search_view(HTML.replace('<th>정기 배송 회선</th><td>0</td>', ''))
        self.assertEqual(view['ownSalesLines'], 0)
        self.assertTrue(view['lineMetricsAvailable']['ownSalesLines'])
        self.assertIsNone(view['regularDeliveryLines'])
        self.assertFalse(view['lineMetricsAvailable']['regularDeliveryLines'])

    def test_realtime_values_do_not_overwrite_closing_values(self):
        html = HTML.replace('<th>대실적(실시간)</th><td>0</td>', '<th>대실적(실시간)</th><td>495,855</td>')
        view = parse_member_search_view(html)
        self.assertEqual(view['maxPvRealtime'], 495855)
        self.assertEqual(view['maxPv'], 0)

    def test_no_table_returns_none(self):
        self.assertIsNone(parse_member_search_view('<div>로그인 필요</div>'))

    def test_member_format_matches_api_collection(self):
        member = member_from_search_view(parse_member_search_view(HTML), {'userId': '913195', 'rankName': 'GD', 'status': '1'})
        for key in ('userId', 'ordPv', 'maxPv', 'minPv', 'rankNewName', 'rankMaxName', 'dormant', 'status',
                    'consumerTotalLines', 'realLines', 'ownSalesLines', 'regularDeliveryLines',
                    'lineMetricsVersion', 'lineMetricsAvailable', 'lineMetricsFound'):
            self.assertIn(key, member)
        self.assertEqual(member['realLines'], 4)


if __name__ == '__main__':
    unittest.main()
