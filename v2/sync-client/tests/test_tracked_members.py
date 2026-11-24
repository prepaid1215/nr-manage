import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import queue_worker
import scraper


class FakePage:
    def __init__(self, ctx=None):
        self.ctx = ctx if ctx is not None else {"myUserId": "2884741", "myRankCd": "30", "payDate": "20261130"}

    def evaluate(self, *_args, **_kwargs):
        return self.ctx


def sales(user_id, max_pv="0", lines="4"):
    return {"rstSalesMap": {"userId": "*" + user_id[1:], "userName": "주영돈", "ordPv": "0", "maxPv": max_pv, "minPv": "0",
                            "rankNewName": "GD", "rankMaxName": "GD", "totalLineCnt": lines, "telCnt": lines,
                            "acGrpCnt": "0", "autoCnt": "0"}}


TRACKED = [
    {"userId": "2893496", "userName": "주영돈", "rankCd": "25", "rankName": "골드"},
    {"userId": "2893497", "userName": "주영돈", "rankCd": "25", "rankName": "골드"},
    {"userId": "2893498", "userName": "주영돈", "rankCd": "25", "rankName": "골드"},
]


class JobTests(unittest.TestCase):
    def test_only_numeric_ids_are_used_and_text_is_limited(self):
        items = queue_worker.tracked_members_from_job({"trackedMembers": [
            {"userId": "2893496", "userName": "가" * 50, "rankCd": "25", "rankName": "골드"},
            {"userId": "../etc", "userName": "bad"},
            "not a dict",
            {"userName": "no id"},
        ]})
        self.assertEqual([i["userId"] for i in items], ["2893496"])
        self.assertEqual(len(items[0]["userName"]), 30)

    def test_missing_or_empty_list(self):
        self.assertEqual(queue_worker.tracked_members_from_job({}), [])
        self.assertEqual(queue_worker.tracked_members_from_job({"trackedMembers": None}), [])

    def test_at_most_150(self):
        many = [{"userId": str(2000000 + i)} for i in range(400)]
        self.assertEqual(len(queue_worker.tracked_members_from_job({"trackedMembers": many})), 150)


class ScrapeTrackedTests(unittest.TestCase):
    def run_scrape(self, tracked, post, page=None, skip=()):
        with mock.patch.object(scraper, "open_page"), mock.patch.object(scraper, "_post_json", side_effect=post):
            return scraper.scrape_tracked_members(page or FakePage(), tracked, skip)

    def test_reads_each_registered_code(self):
        calls = []

        def post(page, path, form):
            calls.append((path, form))
            return sales(form["schUserId"], max_pv="125000" if form["schUserId"] == "2893498" else "0")

        results = self.run_scrape(TRACKED, post)
        self.assertEqual([r["userId"] for r in results], ["2893496", "2893497", "2893498"])
        self.assertEqual(results[2]["maxPv"], 125000)
        self.assertEqual(results[0]["realLines"], 4)
        self.assertTrue(results[0]["lineMetricsAvailable"]["realLines"])
        self.assertEqual(results[0]["userName"], "주영돈")
        self.assertEqual(results[0]["rankName"], "골드")
        self.assertTrue(all("osPersonallySales" in path for path, _ in calls))
        self.assertTrue(all(form["schUserId2"] == "2884741" and form["schRankCd"] == "25" and form["payDate"] == "20261130" for _, form in calls))
        self.assertNotIn("memberNo", results[0])

    def test_one_failure_does_not_stop_the_rest(self):
        def post(page, path, form):
            if form["schUserId"] == "2893497":
                raise RuntimeError("boom")
            return sales(form["schUserId"])

        results = self.run_scrape(TRACKED, post)
        self.assertEqual([r["userId"] for r in results], ["2893496", "2893498"])

    def test_ids_already_in_the_genealogy_are_not_fetched_twice(self):
        fetched = []

        def post(page, path, form):
            fetched.append(form["schUserId"])
            return sales(form["schUserId"])

        results = self.run_scrape(TRACKED, post, skip=["2893496", 2893497])
        self.assertEqual(fetched, ["2893498"])
        self.assertEqual(len(results), 1)

    def test_nothing_to_do_makes_no_requests(self):
        with mock.patch.object(scraper, "open_page") as opened, mock.patch.object(scraper, "_post_json") as post:
            self.assertEqual(scraper.scrape_tracked_members(FakePage(), [], ()), [])
            self.assertEqual(scraper.scrape_tracked_members(FakePage(), None, ()), [])
        post.assert_not_called()
        opened.assert_not_called()

    def test_missing_account_context_skips_quietly(self):
        page = FakePage({"myUserId": "", "myRankCd": "", "payDate": ""})
        results = self.run_scrape(TRACKED, lambda *a: sales("2893496"), page=page)
        self.assertEqual(results, [])

    def test_does_not_reload_the_page_when_the_context_is_already_readable(self):
        with mock.patch.object(scraper, "open_page") as opened, \
             mock.patch.object(scraper, "_post_json", side_effect=lambda page, path, form: sales(form["schUserId"])):
            scraper.scrape_tracked_members(FakePage(), TRACKED, ())
        opened.assert_not_called()


if __name__ == "__main__":
    unittest.main()
