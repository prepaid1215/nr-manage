import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scraper import extract_line_metrics


class LineMetricTests(unittest.TestCase):
    def test_nrc_selected_member_fields(self):
        result = extract_line_metrics({'rstSalesMap': {'totalLineCnt': '5', 'telCnt': '5', 'acGrpCnt': '0', 'autoCnt': '0'}})
        self.assertEqual([result[key] for key in ('consumerTotalLines', 'realLines', 'ownSalesLines', 'regularDeliveryLines')], [5, 5, 0, 0])
        self.assertTrue(all(result['lineMetricsAvailable'].values()))

    def test_missing_metrics_stay_unknown_even_when_total_exists(self):
        result = extract_line_metrics({'rstSalesMap': {'totalLineCnt': 5}})
        self.assertTrue(result['lineMetricsFound'])
        self.assertIsNone(result['realLines'])
        self.assertFalse(result['lineMetricsAvailable']['realLines'])
        self.assertIsNone(result['ownSalesLines'])
        self.assertIsNone(result['regularDeliveryLines'])

    def test_explicit_zero_is_present(self):
        result = extract_line_metrics({'rstSalesMap': {'totalLineCnt': 0, 'telCnt': '0'}})
        self.assertEqual(result['realLines'], 0)
        self.assertTrue(result['lineMetricsAvailable']['realLines'])

    def test_selected_member_summary_wins(self):
        result = extract_line_metrics({'otherSummary': {'realLineCnt': 99}, 'rstSalesMap': {'telCnt': 5}})
        self.assertEqual(result['realLines'], 5)

    def test_official_field_wins_over_legacy_alias(self):
        result = extract_line_metrics({'rstSalesMap': {'realLineCnt': 0, 'telCnt': 5.0}})
        self.assertEqual(result['realLines'], 5)

    def test_known_legacy_aliases_and_numeric_formatting(self):
        result = extract_line_metrics({'data': {'consumerTotalLineCnt': '1,234', 'realLineCnt': '12회선', 'ownLineCnt': 3, 'deliveryLineCnt': 4}})
        self.assertEqual([result[key] for key in ('consumerTotalLines', 'realLines', 'ownSalesLines', 'regularDeliveryLines')], [1234, 12, 3, 4])

    def test_unrelated_keys_invalid_and_missing_values_are_not_zero(self):
        for data in ({}, {'telCnt': None}, {'telCnt': ''}, {'telCnt': True}, {'telCnt': -1}, {'telCnt': '조회불가'}, {'unrelatedRealLineCnt': 99}):
            result = extract_line_metrics(data)
            self.assertFalse(result['lineMetricsFound'])
            self.assertIsNone(result['realLines'])


if __name__ == '__main__':
    unittest.main()
