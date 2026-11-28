import assert from "node:assert/strict";
import { showsVisitBranch, visitBranchPatch, isMissingBranchColumn, memoWithBranch, visitLabel, BRANCH_MAX } from "../js/customer-visit.js";

// 지점방문일 때만 입력칸이 보인다
assert.equal(showsVisitBranch("지점방문"), true);
for (const method of ["플랫폼", "앤스마트", "", undefined]) assert.equal(showsVisitBranch(method), false, String(method));

// 값이 있으면 저장하고 앞뒤 공백을 지운다
assert.deepEqual(visitBranchPatch("지점방문", "  강남점 ", ""), { branch: "강남점", patch: { visit_branch: "강남점" } });
// 지점방문이 아니면 입력칸에 글자가 남아 있어도 저장하지 않는다
assert.deepEqual(visitBranchPatch("플랫폼", "강남점", ""), { branch: "", patch: {} });
// 이전에 값이 있었는데 지점방문을 풀거나 비우면 지운다
assert.deepEqual(visitBranchPatch("플랫폼", "강남점", "서초점"), { branch: "", patch: { visit_branch: null } });
assert.deepEqual(visitBranchPatch("지점방문", "   ", "서초점"), { branch: "", patch: { visit_branch: null } });
// 이전 값도 없고 비어 있으면 키를 아예 보내지 않는다(열이 없는 DB에서도 일반 등록이 깨지지 않게)
assert.deepEqual(visitBranchPatch("지점방문", "", ""), { branch: "", patch: {} });
assert.deepEqual(visitBranchPatch("플랫폼", "", undefined), { branch: "", patch: {} });
// 너무 길면 자른다
assert.equal(visitBranchPatch("지점방문", "가".repeat(200), "").branch.length, BRANCH_MAX);

// SQL 적용 전의 오류 구분
assert.equal(isMissingBranchColumn({ message: "Could not find the 'visit_branch' column of 'customers' in the schema cache" }), true);
assert.equal(isMissingBranchColumn({ message: 'column "visit_branch" of relation "customers" does not exist' }), true);
assert.equal(isMissingBranchColumn({ message: "permission denied" }), false);
assert.equal(isMissingBranchColumn(null), false);

// 열이 없을 때는 메모에 남긴다
assert.equal(memoWithBranch("", "강남점"), "방문 지점: 강남점");
assert.equal(memoWithBranch("전화 요망", "강남점"), "전화 요망\n방문 지점: 강남점");
assert.equal(memoWithBranch("방문 지점: 강남점", "강남점"), "방문 지점: 강남점", "중복하지 않는다");
assert.equal(memoWithBranch("메모", ""), "메모");
assert.equal(memoWithBranch("", ""), null);

// 목록 카드 설명
assert.equal(visitLabel({ seller: "주땡땡", activation_method: "지점방문", visit_branch: "강남점" }), "매출자 주땡땡 · 지점방문 강남점");
assert.equal(visitLabel({ seller: "주땡땡", activation_method: "플랫폼", visit_branch: "강남점" }), "매출자 주땡땡");
assert.equal(visitLabel({ activation_method: "지점방문" }), "");
assert.equal(visitLabel(null), "");
console.log("Customer visit tests passed.");

// BP FINDER+ 센터명: 이름만 뽑고 공백·중복을 정리해 가나다순으로
import { centerNames, loadCenterNames, CENTERS_URL } from "../js/customer-visit.js";
assert.deepEqual(centerNames({ centers: [{ name: " 군자BP ", id: 1 }, { name: "가산역BP" }, { name: "군자BP" }, { name: "" }, {}, null] }), ["가산역BP", "군자BP"]);
assert.deepEqual(centerNames([{ name: "나BP" }, { name: "가BP" }]), ["가BP", "나BP"]);
assert.deepEqual(centerNames(null), []);
assert.deepEqual(centerNames({ centers: "x" }), []);

const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };
const okFetch = (names) => async (url) => { assert.equal(url, CENTERS_URL); return { ok: true, json: async () => ({ centers: names.map((name) => ({ name })) }) }; };
// 처음엔 가져와서 저장한다. 이후에는 저장분을 바로 돌려주고, 뒤에서 새로 받아 바뀌었을 때만 갱신·알린다
{
  const storage = memory(); let calls = 0; const updates = [];
  const names = ["B센터", "A센터"];
  const fetchFn = async (u) => { calls++; return okFetch(names)(u); };
  assert.deepEqual(await loadCenterNames({ fetchFn, storage }), ["A센터", "B센터"]);
  assert.equal(calls, 1);
  // 저장분이 있으면 오래돼도 바로 쓴다(만료 없음). 같은 내용이면 알리지 않는다
  assert.deepEqual(await loadCenterNames({ fetchFn, storage, onUpdate: (n) => updates.push(n) }), ["A센터", "B센터"]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 2);
  assert.deepEqual(updates, []);
  // 새 센터가 생기면 저장분을 갱신하고 알린다
  names.push("C센터");
  assert.deepEqual(await loadCenterNames({ fetchFn, storage, onUpdate: (n) => updates.push(n) }), ["A센터", "B센터"]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(updates, [["A센터", "B센터", "C센터"]]);
  assert.deepEqual(await loadCenterNames({ fetchFn: async () => { throw new Error("offline"); }, storage }), ["A센터", "B센터", "C센터"]);
}
// 실패하면 저장분을 쓰고, 아무것도 없으면 빈 목록
{
  const failing = async () => { throw new Error("offline"); };
  assert.deepEqual(await loadCenterNames({ fetchFn: failing, storage: memory() }), []);
  assert.deepEqual(await loadCenterNames({ fetchFn: async () => ({ ok: false, status: 500 }), storage: memory() }), []);
  assert.deepEqual(await loadCenterNames({ fetchFn: okFetch([]), storage: memory() }), []);
}
console.log("Customer visit center list tests passed.");
