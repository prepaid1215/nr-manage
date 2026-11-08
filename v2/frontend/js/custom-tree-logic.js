// 내 계보도: 제외한 회원을 화면에서만 빼고, 그 하위는 가장 가까운 표시 중인 윗사람 밑으로 붙인다.
// 실적 계산용 model(byId/children)은 건드리지 않는다.

/** 제외 회원을 건너뛴 표시용 children Map을 만든다. rootId 자신은 제외해도 항상 보인다. */
export function visibleChildrenMap(model, excluded, rootId = "") {
  const skip = new Set([...excluded].map(String));
  skip.delete(String(rootId));
  const kidsOf = (id, seen) => {
    const out = [];
    for (const child of model.children.get(String(id)) || []) {
      const cid = String(child.userId);
      if (seen.has(cid)) continue;
      if (skip.has(cid)) {
        out.push(...kidsOf(cid, new Set(seen).add(cid)));
      } else {
        out.push(child);
      }
    }
    return out;
  };
  const result = new Map();
  for (const id of model.byId.keys()) {
    if (skip.has(id)) continue;
    result.set(id, kidsOf(id, new Set([id])));
  }
  return result;
}

/** 제외 목록에서 현재 수집 자료에 없는 회원번호를 걷어낸 집합 */
export function activeExclusions(model, excluded) {
  return new Set([...excluded].map(String).filter((id) => model.byId.has(id)));
}
