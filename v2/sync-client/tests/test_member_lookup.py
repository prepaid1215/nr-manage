import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import scraper


class FakePage:
    def evaluate(self, *_args, **_kwargs):
        return {"myUserId": "2884741", "myRankCd": "30", "payDate": "20261130"}


def popup_rows():
    # 실제 NRC 응답 구조: 본코드 + 그 사람이 후원인인 서브1·서브2
    return {"rstLst": [
        {"userId": "2913195", "userName": "김정경", "rankCd": "25", "rankName": "골드", "ppName": "주영돈", "ppId": "2893497"},
        {"userId": "2913196", "userName": "김정경", "rankCd": "25", "rankName": "골드", "ppName": "김정경", "ppId": "2913195"},
        {"userId": "2913197", "userName": "김정경", "rankCd": "25", "rankName": "골드", "ppName": "김정경", "ppId": "2913195"},
    ], "rstTot": {"totCnt": 3}}


def sales_for(user_id):
    values = {"2913195": ("0", "4"), "2913196": ("5000", "2"), "2913197": ("0", "0")}
    max_pv, lines = values[user_id]
    return {"rstSalesMap": {"userId": "*" + user_id[1:], "userName": "김정경", "ordPv": "0", "maxPv": max_pv, "minPv": "0",
                            "rankNewName": "GD", "rankMaxName": "GD", "totalLineCnt": lines, "telCnt": lines,
                            "acGrpCnt": "0", "autoCnt": "0"}}


class RoleTests(unittest.TestCase):
    def test_main_and_two_subs(self):
        roles = scraper.label_member_roles([{"userId": "2913195"}, {"userId": "2913196"}, {"userId": "2913197"}])
        self.assertEqual(roles["2913195"], ("본", "2913195"))
        self.assertEqual(roles["2913196"], ("서브1", "2913195"))
        self.assertEqual(roles["2913197"], ("서브2", "2913195"))

    def test_unrelated_same_name_is_single(self):
        roles = scraper.label_member_roles([{"userId": "2913195"}, {"userId": "2999000"}])
        self.assertEqual(roles["2913195"][0], "단독")
        self.assertEqual(roles["2999000"][0], "단독")


class LookupTests(unittest.TestCase):
    def run_lookup(self, post):
        with mock.patch.object(scraper, "open_page"), mock.patch.object(scraper, "_post_json", side_effect=post):
            return scraper.lookup_member_sales(FakePage(), "김정경")

    def test_search_request_uses_my_id_and_name(self):
        calls = []

        def post(page, path, form):
            calls.append((path, form))
            return popup_rows() if "osPopupMemberList" in path else sales_for(form["schUserId"])

        result = self.run_lookup(post)
        search = next(form for path, form in calls if "osPopupMemberList" in path)
        self.assertEqual((search["schUserName"], search["schUserId"], search["schFlg"], search["payDate"]), ("김정경", "2884741", "F", "20261130"))
        sales = [form for path, form in calls if "osPersonallySales" in path]
        self.assertEqual(len(sales), 3)
        self.assertTrue(all(form["schUserId2"] == "2884741" and form["schRankCd2"] == "30" and form["schGubun"] == "2" for form in sales))
        self.assertEqual(result["total"], 3)

    def test_result_values_and_roles(self):
        def post(page, path, form):
            return popup_rows() if "osPopupMemberList" in path else sales_for(form["schUserId"])

        members = self.run_lookup(post)["members"]
        self.assertEqual([m["role"] for m in members], ["본", "서브1", "서브2"])
        self.assertEqual([m["userId"] for m in members], ["2913195", "2913196", "2913197"])
        self.assertEqual(members[0]["memberNo"], "*913195")
        self.assertEqual(members[1]["maxPv"], 5000)
        self.assertEqual(members[0]["realLines"], 4)
        self.assertEqual(members[2]["realLines"], 0, "표시된 0은 0회선")
        self.assertTrue(members[2]["lineMetricsAvailable"]["realLines"])

    def test_one_failure_does_not_hide_others(self):
        def post(page, path, form):
            if "osPopupMemberList" in path:
                return popup_rows()
            if form["schUserId"] == "2913196":
                raise RuntimeError("boom")
            return sales_for(form["schUserId"])

        members = self.run_lookup(post)["members"]
        self.assertEqual(len(members), 3)
        self.assertIn("boom", members[1]["error"])
        self.assertNotIn("error", members[0])

    def test_no_match_returns_empty_list(self):
        result = self.run_lookup(lambda page, path, form: {"rstLst": [], "rstTot": {"totCnt": 0}})
        self.assertEqual(result["members"], [])
        self.assertEqual(result["total"], 0)

    def test_blank_name_is_rejected(self):
        with mock.patch.object(scraper, "open_page"), self.assertRaises(ValueError):
            scraper.search_members_by_name(FakePage(), "   ")


if __name__ == "__main__":
    unittest.main()
