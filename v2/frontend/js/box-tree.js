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
  return `<${tag} class="box-node ${boxRankTone(row)}${options.selected ? " selected" : ""}${options.marked ? " marked" : ""}${options.sale ? " sale" : ""}"${attrs}><b>${safe(row?.userName || "이름 없음")}</b><small>*${safe(id)}</small><small>${safe(row?.rankName || "회원")}/${safe(row?.rankMaxName || "회원")}</small>${options.hideDate ? "" : `<small>${safe(row?.regDate || "-")}</small>`}<em>본인 ${number(row?.ordPv)} NV</em><span class="box-line-total">라인 전체 ${number(lineOnly)}</span><span class="box-line-total box-grand-total">총(본인+전체) ${number(grandTotal)}</span>${note}${badge}${sale}</${tag}>`;
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
    const hidden = !showKids && kids.length ? descendantCount(id) : 0;
    return `<li>${boxCardHtml(row, {
      badge: badges[id],
      note: notes[id],
      sale: sales[id],
      totalOf,
      clickable,
      hideDate: options.hideDate,
      selected: id === selectedId,
      marked: Boolean(badges[id]),
    })}${hidden ? `<div class="box-more">아래 ${hidden}명 더 있음</div>` : ""}${
      showKids
        ? `<ul>${kids.map((kid) => node(kid, level + 1, nextPath)).join("")}</ul>`
        : ""
    }</li>`;
  };

  return `<ul>${node(root, 1, new Set())}</ul>`;
}
