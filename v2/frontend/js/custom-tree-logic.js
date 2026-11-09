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

// ── 사람 단위 선택 ──────────────────────────────────────────────────────────
// 한 사람은 본코드와 그 바로 뒤 두 번호(서브1·서브2) 3개 코드가 한 몸이다.
// 본코드의 자식으로 같은 이름의 +1, +2 코드가 있으면 한 사람으로 묶고, 아니면 코드 하나가 한 사람이다.
export function buildPersons(model) {
  const personOf = new Map(); // 코드 → 본코드(사람 키)
  const codes = new Map(); // 사람 키 → 코드 목록
  for (const row of model.rows) {
    const id = String(row.userId);
    if (personOf.has(id)) continue;
    const kidIds = (model.children.get(id) || []).map((kid) => String(kid.userId));
    const a = String(Number(id) + 1);
    const b = String(Number(id) + 2);
    const same = (code) => model.byId.get(code)?.userName === row.userName;
    if (kidIds.includes(a) && kidIds.includes(b) && same(a) && same(b) && !personOf.has(a) && !personOf.has(b)) {
      [id, a, b].forEach((code) => personOf.set(code, id));
      codes.set(id, [id, a, b]);
    }
  }
  for (const row of model.rows) {
    const id = String(row.userId);
    if (!personOf.has(id)) {
      personOf.set(id, id);
      codes.set(id, [id]);
    }
  }
  const byId = new Map();
  const children = new Map();
  for (const [key, list] of codes) {
    byId.set(key, model.byId.get(key));
    const seen = new Set();
    const kids = [];
    for (const code of list) {
      for (const kid of model.children.get(code) || []) {
        const childKey = personOf.get(String(kid.userId));
        if (!childKey || childKey === key || seen.has(childKey)) continue;
        seen.add(childKey);
        kids.push(model.byId.get(childKey));
      }
    }
    children.set(key, kids);
  }
  const tops = [...byId.keys()].filter((key) => {
    const parent = String(model.byId.get(key)?.ppId ?? "");
    return !parent || !model.byId.has(parent);
  });
  return { personOf, codes, byId, children, tops };
}

/** 켜진(선택한) 사람만 남긴 사람 단위 계보. 켜지지 않은 사람은 건너뛰고 그 하위는 윗사람 밑에 붙는다. */
export function litPersonTree(persons, lit) {
  const keep = new Set([...lit].map(String).filter((key) => persons.byId.has(key)));
  const down = (key, seen) =>
    (persons.children.get(key) || []).flatMap((kid) => {
      const childKey = String(kid.userId);
      if (seen.has(childKey)) return [];
      const next = new Set(seen).add(childKey);
      return keep.has(childKey) ? [kid] : down(childKey, next);
    });
  const children = new Map();
  keep.forEach((key) => children.set(key, down(key, new Set([key]))));
  const hasLitAncestor = (key) => {
    let parent = String(persons.byId.get(key)?.ppId ?? "");
    let guard = 0;
    while (parent && guard++ < 200) {
      const parentKey = persons.personOf.get(parent);
      if (!parentKey) return false;
      if (keep.has(parentKey)) return true;
      parent = String(persons.byId.get(parentKey)?.ppId ?? "");
    }
    return false;
  };
  const tops = [...keep].filter((key) => !hasLitAncestor(key));
  return { keep, children, tops };
}

/** 켜지 않은 사람의 코드 전부. 마감 계산의 '제외' 집합으로 그대로 쓴다. */
export function codesOutsidePicks(persons, lit) {
  const keep = new Set([...lit].map(String).filter((key) => persons.byId.has(key)));
  const out = new Set();
  persons.codes.forEach((list, key) => {
    if (!keep.has(key)) list.forEach((code) => out.add(code));
  });
  return out;
}
