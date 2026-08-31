const number = (value) => Number(value || 0).toLocaleString("ko-KR");
const safe = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

export const boxRankTone = (row) => {
  const rank = String(row?.rankName || "");
  if (/GD/i.test(rank)) return "gd";
  if (/DT/i.test(rank)) return "dt";
  return "member";
};

const defaultTotal = (row) =>
  Number(row?.ordPv || 0) + Number(row?.maxPv || 0) + Number(row?.minPv || 0);

export function boxCardHtml(row, options = {}) {
  const id = String(row?.userId ?? "");
  const badge = options.badge
    ? `<span class="box-badge">${safe(options.badge)}</span>`
    : "";
  const note = options.note
    ? `<span class="box-note">${safe(options.note)}</span>`
    : "";
  const sale = options.sale
    ? `<span class="box-sale">💰 추천 매출 ${safe(options.sale)}</span>`
    : "";
  // totalOf(본인 포함 raw 총합 함수: defaultTotal도 branchBreakdown.total도
  // 이미 본인(ordPv)을 포함한다. 그래서 총(본인+전체)에는 이 값을 그대로 쓰고,
  // "라인 전체"는 여기서 본인 몫만 빼서 보여준다 (본인을 두 번 더하면 안 됨).
  const grandTotal = Number((options.totalOf || defaultTotal)(row) || 0);
  const lineOnly = grandTotal - Number(row?.ordPv || 0);
  const tag = options.clickable === false ? "div" : "button";
  const attrs =
    options.clickable === false
      ? ""
      : ` data-member="${safe(id)}" type="button"`;
  // 진짜 <button> 안에 또 <button>을 넣으면 안 되므로(중첩 button은 무효한
  // HTML) 숨기기/복원 컨트롤은 <span role="button">로 만든다. 클릭 위임
  // 쪽(호출부)에서 data-hide-member/data-restore-member를 먼저 확인하고
  // data-member 카드 이동은 그 다음에 처리해야 한다.
  const hideBtn = options.hideable
    ? options.hidden
      ? `<span class="box-hide restore" data-restore-member="${safe(id)}" role="button" tabindex="0" title="다시 보기">↺</span>`
      : `<span class="box-hide" data-hide-member="${safe(id)}" role="button" tabindex="0" title="숨기기">×</span>`
    : "";
  return `<${tag} class="box-node ${boxRankTone(row)}${options.selected ? " selected" : ""}${options.marked ? " marked" : ""}${options.sale ? " sale" : ""}${options.hidden ? " box-hidden-card" : ""}"${attrs}><b>${safe(row?.userName || "이름 없음")}</b><small>*${safe(id)}</small><small>${safe(row?.rankName || "회원")}/${safe(row?.rankMaxName || "회원")}</small>${options.hideDate ? "" : `<small>${safe(row?.regDate || "-")}</small>`}<em>본인 ${number(row?.ordPv)} NV</em><span class="box-line-total">라인 전체 ${number(lineOnly)}</span><span class="box-line-total box-grand-total">총(본인+전체) ${number(grandTotal)}</span>${note}${badge}${sale}${hideBtn}</${tag}>`;
}

// ctx: { byId: Map, children: Map } — buildPerformanceModel 결과나 동일 구조
export function boxTreeHtml(ctx, rootId, options = {}) {
  const root = ctx.byId.get(String(rootId));
  if (!root) return '<p class="help">표시할 회원이 없습니다.</p>';
  const depth = options.depth ?? 3;
  const badges = options.badges || {};
  const notes = options.notes || {};
  const sales = options.sales || {};
  const totalOf = options.totalOf || defaultTotal;
  const clickable = options.clickable !== false;
  const selectedId = options.selectedId ? String(options.selectedId) : "";
  const hiddenIds = options.hiddenIds || new Set();
  const showHidden = Boolean(options.showHidden);
  const hideable = Boolean(options.hideable);
  const kidsOf = (id) => ctx.children.get(String(id)) || [];

  const descendantCount = (id) => {
    let count = 0;
    const stack = [...kidsOf(id)];
    const seen = new Set();
    while (stack.length) {
      const row = stack.pop();
      const key = String(row.userId);
      if (seen.has(key)) continue;
      seen.add(key);
      count += 1;
      kidsOf(key).forEach((child) => stack.push(child));
    }
    return count;
  };

  const node = (row, level, path) => {
    const id = String(row.userId);
    if (path.has(id)) return "";
    const nextPath = new Set(path);
    nextPath.add(id);
    const kids = kidsOf(id);
    const showKids = level < depth && kids.length;
    const hiddenCount = !showKids && kids.length ? descendantCount(id) : 0;
    const childrenHtml = showKids
      ? `<ul>${kids.map((kid) => node(kid, level + 1, nextPath)).join("")}</ul>`
      : "";
    // 최상위(level 1)는 숨김 목록에 있어도 카드 자체는 항상 보여준다 —
    // 안 그러면 지금 보고 있는 기준 사업자 자체가 숨겨져서 트리가
    // 통째로 사라진다. 숨긴 카드는 그 사람만 작은 자리표시자로 접고,
    // 그 아래 라인(하위)은 구조/연결선 그대로 계속 보여준다.
    if (level > 1 && hiddenIds.has(id) && !showHidden) {
      return `<li><div class="box-node box-node-collapsed"><small>${safe(row?.userName || "이름 없음")}</small><span class="box-hide restore" data-restore-member="${safe(id)}" role="button" tabindex="0" title="다시 보기">↺ 숨김</span></div>${childrenHtml}</li>`;
    }
    return `<li>${boxCardHtml(row, {
      badge: badges[id],
      note: notes[id],
      sale: sales[id],
      totalOf,
      clickable,
      hideDate: options.hideDate,
      selected: id === selectedId,
      marked: Boolean(badges[id]),
      hideable,
      hidden: hiddenIds.has(id),
    })}${hiddenCount ? `<div class="box-more">아래 ${hiddenCount}명 더 있음</div>` : ""}${childrenHtml}</li>`;
  };

  return `<ul>${node(root, 1, new Set())}</ul>`;
}
