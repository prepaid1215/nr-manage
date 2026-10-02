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
  // options.badge가 문자열이면 그냥 표시만 한다. {text, applied} 객체면
  // 누를 때 실제로 그 사람 실적에 반영해서(위쪽까지 다시 계산해서) 다시 그려주는
  // 토글 배지로 만든다 (호출부의 data-balance-preview 재계산 로직이 실제 상태를 갖고 있고,
  // 여기서는 그 결과를 보여주기만 한다).
  const badge =
    options.badge && typeof options.badge === "object"
      ? `<span class="box-badge box-badge-toggle${options.badge.applied ? " showing-after" : ""}" data-badge-toggle="${safe(id)}" role="button" tabindex="0" title="눌러서 적용/취소 (위쪽까지 다시 계산됨)">${safe(options.badge.text)}</span>`
      : options.badge
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
  // "위부터" 우선 배치 토글 — 켜면(▼, 상위부터 아래로) 이 사람 라인은
  // 부족분을 하위로 안 내려 보내고 본인 코드로 바로 채운다. 꺼져 있으면
  // (▲, 아래서 위로) 기존처럼 가장 깊은 하위부터 채워 위로 올라온다.
  const priorityBtn = options.hideable
    ? options.priority
      ? `<span class="box-priority on" data-toggle-priority="${safe(id)}" role="button" tabindex="0" title="상위부터 아래로 채우는 중 (누르면 끄기)">▼</span>`
      : `<span class="box-priority" data-toggle-priority="${safe(id)}" role="button" tabindex="0" title="아래에서 위로 채우는 중 (누르면 상위부터 채우기로 전환)">▲</span>`
    : "";
  // "수익계좌" 토글 — 켜면 이 사람은 대·소를 각각 독립적으로 목표까지 채워야
  // 마감되는 것으로 본다(그래야 본인 계좌로 수당이 생김). 꺼져 있으면(기본값)
  // 대+소 합계가 목표 합계만 넘으면 되는 것으로 본다(그냥 통과 라인).
  const incomeToggleable = options.incomeToggleIds?.has(id);
  const incomeOn = options.incomeMarked?.has(id);
  const incomeBtn = incomeToggleable
    ? incomeOn
      ? `<span class="box-income on" data-toggle-income="${safe(id)}" role="button" tabindex="0" title="수익계좌로 보는 중 · 대·소 각각 채워야 함 (누르면 끄기)">💰수익계좌</span>`
      : `<span class="box-income" data-toggle-income="${safe(id)}" role="button" tabindex="0" title="지금은 합계만 넘으면 통과 · 누르면 수익계좌(대·소 각각)로 전환">☆수익계좌로</span>`
    : "";
  return `<${tag} class="box-node ${boxRankTone(row)}${options.selected ? " selected" : ""}${options.marked ? " marked" : ""}${options.sale ? " sale" : ""}${options.hidden ? " box-hidden-card" : ""}${options.priority ? " box-priority-card" : ""}"${attrs}><b>${safe(row?.userName || "이름 없음")}</b><small>*${safe(id)}</small><small>${safe(row?.rankName || "회원")}/${safe(row?.rankMaxName || "회원")}</small>${options.hideDate ? "" : `<small>${safe(row?.regDate || "-")}</small>`}<em>본인 ${number(row?.ordPv)} NV</em><span class="box-line-total">라인 전체 ${number(lineOnly)}</span><span class="box-line-total box-grand-total">총(본인+전체) ${number(grandTotal)}</span>${note}${badge}${sale}${hideBtn}${priorityBtn}${incomeBtn}</${tag}>`;
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
  const priorityIds = options.priorityIds || new Set();
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
      priority: priorityIds.has(id),
      incomeToggleIds: options.incomeToggleIds,
      incomeMarked: options.incomeMarked,
    })}${hiddenCount ? `<div class="box-more">아래 ${hiddenCount}명 더 있음</div>` : ""}${childrenHtml}</li>`;
  };

  return `<ul>${node(root, 1, new Set())}</ul>`;
}
