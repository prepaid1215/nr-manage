// 고객 등록의 "방문 지점" 규칙. 개통방법이 '지점방문'일 때만 어느 지점을 방문했는지 저장한다.
export const VISIT_METHOD = "지점방문";
export const BRANCH_MAX = 60;

export const showsVisitBranch = (method) => method === VISIT_METHOD;

// 저장할 때 customers에 더할 값. 열(visit_branch)이 아직 없는 DB에서도 일반 등록이 깨지지 않도록,
// 값이 있을 때와 "이전에 값이 있었는데 비울 때"만 키를 보낸다.
export function visitBranchPatch(method, branchText, previousBranch) {
  const branch = showsVisitBranch(method) ? String(branchText || "").trim().slice(0, BRANCH_MAX) : "";
  if (branch) return { branch, patch: { visit_branch: branch } };
  return { branch: "", patch: previousBranch ? { visit_branch: null } : {} };
}

// DB에 visit_branch 열이 없을 때(SQL 적용 전)의 오류인지.
export const isMissingBranchColumn = (error) => /visit_branch/i.test(String((error && error.message) || ""));

// 열이 없어도 방문 지점이 사라지지 않도록 메모 끝에 남긴다. 이미 적혀 있으면 중복하지 않는다.
export function memoWithBranch(memo, branch) {
  const text = String(memo || "").trim();
  const line = `방문 지점: ${branch}`;
  if (!branch || text.includes(line)) return text || null;
  return text ? `${text}\n${line}` : line;
}

// 고객 목록 카드에 붙일 짧은 설명(없으면 빈 문자열).
export function visitLabel(row) {
  const parts = [];
  if (row && row.seller) parts.push(`매출자 ${row.seller}`);
  if (row && row.activation_method === VISIT_METHOD && row.visit_branch) parts.push(`지점방문 ${row.visit_branch}`);
  return parts.join(" · ");
}

// 방문 지점 후보: BP FINDER+(앤텔레콤 센터 찾기)에 올라 있는 센터명만 가져온다. 공개 JSON이며 CORS가 열려 있다.
export const CENTERS_URL = "https://bp-finder.vercel.app/data/centers.json";
const CENTERS_CACHE_KEY = "bpFinderCenterNames";

// centers.json({centers:[{name,...}]} 또는 배열)에서 센터명만 뽑아 공백 정리·중복 제거·가나다순으로 돌려준다.
export function centerNames(data) {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.centers) ? data.centers : []);
  const names = list.map((c) => String((c && c.name) || "").trim()).filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, "ko"));
}

// 한 번 가져온 목록은 계속 저장해 두고 바로 쓴다(만료 없음). 저장분이 있으면 뒤에서 조용히 새로 받아 바뀐 경우에만 저장분을 갱신하고 onUpdate로 알린다.
// 저장분이 없으면 가져올 때까지 기다리고, 실패하면 빈 목록(직접 입력은 그대로 가능).
export async function loadCenterNames({ fetchFn = globalThis.fetch, storage, onUpdate } = {}) {
  let cachedNames = [];
  try {
    const cached = JSON.parse((storage && storage.getItem(CENTERS_CACHE_KEY)) || "null");
    if (cached && Array.isArray(cached.names)) cachedNames = cached.names;
  } catch {}
  const refresh = async () => {
    try {
      const response = await fetchFn(CENTERS_URL);
      if (!response.ok) throw new Error(String(response.status));
      const names = centerNames(await response.json());
      if (!names.length) return cachedNames;
      if (JSON.stringify(names) !== JSON.stringify(cachedNames)) {
        try {
          storage && storage.setItem(CENTERS_CACHE_KEY, JSON.stringify({ names }));
        } catch {}
        if (cachedNames.length && onUpdate) onUpdate(names);
      }
      return names;
    } catch {
      return cachedNames;
    }
  };
  if (cachedNames.length) {
    refresh();
    return cachedNames;
  }
  return refresh();
}
