import { supabase } from "./supabase.js?v=20260829-34";
import { boxCardHtml, boxTreeHtml } from "./box-tree.js?v=20260829-53";
import { friendlyError } from "./errors.js?v=20260830-1";

const number = (value) => Number(value || 0).toLocaleString("ko-KR");
const safe = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

export async function boxGenealogyPage(root) {
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>박스 계보도</h2><p class="help" id="boxCollected">최신 데이터를 불러오는 중...</p></div><button class="secondary compact" id="boxReload" type="button">새로고침</button></div><div class="box-tools"><label>회원 검색<input id="boxSearch" type="search" placeholder="이름 또는 회원번호"></label><label>몇 단계까지 볼지<select id="boxDepth"><option value="2">2단계</option><option value="3" selected>3단계</option><option value="4">4단계</option><option value="5">5단계</option></select></label><span class="box-zoom"><button class="secondary compact" id="boxZoomOut" type="button" aria-label="축소">−</button><button class="secondary compact" id="boxZoomReset" type="button">100%</button><button class="secondary compact" id="boxZoomIn" type="button" aria-label="확대">＋</button></span><button class="secondary compact" id="boxPrint" type="button">🖨 인쇄</button></div><div class="tree-focus-bar" id="boxFocusBar"></div><p class="help">박스를 누르면 그 회원을 맨 위로 놓고 다시 그립니다. 빈 곳을 끌면 화면이 움직입니다.</p><div id="boxError" class="error"></div><div class="box-tree pannable-tree"><div class="tree-stage" id="boxStage"></div></div></section>`;
  const $ = (id) => document.getElementById(id);
  $("boxReload").onclick = () => boxGenealogyPage(root);

  const { data, error } = await supabase
    .from("nrc_sync_snapshots")
    .select("source_account_id,payload,collected_at")
    .eq("snapshot_type", "combined")
    .order("collected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    $("boxCollected").textContent = "저장된 계보 데이터가 없습니다.";
    $("boxError").textContent = friendlyError(error, "계보 데이터를 불러오지 못했습니다.");
    $("boxStage").innerHTML =
      '<p class="help">홈 화면에서 매출받기를 먼저 실행하세요.</p>';
    return;
  }

  const payload =
    typeof data.payload === "string" ? JSON.parse(data.payload) : data.payload;
  const sales = new Map(
    (payload.members || []).map((item) => [String(item.userId), item]),
  );
  const rows = (payload.rstLst || []).map((item) => ({
    ...item,
    ...(sales.get(String(item.userId)) || {}),
  }));
  const byId = new Map(rows.map((item) => [String(item.userId), item]));
  const children = new Map();
  rows.forEach((item) => {
    const parent = String(item.ppId || "");
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  });
  children.forEach((items) =>
    items.sort(
      (left, right) =>
        String(left.abPos || "").localeCompare(String(right.abPos || "")) ||
        String(left.userId).localeCompare(String(right.userId)),
    ),
  );
  const roots = rows.filter(
    (item) => !item.ppId || !byId.has(String(item.ppId)),
  );

  const kidsOf = (id) => children.get(String(id)) || [];
  const lineTotal = (row) =>
    Number(row?.ordPv || 0) + Number(row?.maxPv || 0) + Number(row?.minPv || 0);
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

  let focused = roots[0] || rows[0] || null;
  let depth = 3;
  let zoom = 1;
  let selectedId = focused ? String(focused.userId) : "";

  $("boxCollected").textContent =
    `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · 전체 ${rows.length.toLocaleString()}명 · NRC ${data.source_account_id || "-"}`;

  const bindNodes = () => {
    $("boxStage")
      .querySelectorAll("[data-member]")
      .forEach((button) => {
        button.onclick = () => {
          const row = byId.get(button.dataset.member);
          if (!row) return;
          focused = row;
          selectedId = String(row.userId);
          $("boxSearch").value = "";
          render();
        };
      });
  };

  const render = () => {
    const query = $("boxSearch").value.trim().toLowerCase();
    if (query) {
      const matches = rows.filter(
        (item) =>
          String(item.userName || "")
            .toLowerCase()
            .includes(query) || String(item.userId || "").includes(query),
      );
      $("boxFocusBar").innerHTML = `<span>검색 결과 <b>${matches.length}명</b> · 박스를 누르면 그 회원부터 그립니다.</span>`;
      $("boxStage").innerHTML = matches.length
        ? `<div class="box-search-hits">${matches
            .slice(0, 60)
            .map((item) =>
              boxCardHtml(item, { totalOf: lineTotal, hideDate: true }),
            )
            .join("")}</div>`
        : '<p class="help">검색 결과가 없습니다.</p>';
      bindNodes();
      return;
    }
    const parent = focused ? byId.get(String(focused.ppId || "")) : null;
    $("boxFocusBar").innerHTML = `<span>기준 회원: <b>${safe(focused?.userName || "-")}</b> <small>*${safe(focused?.userId || "")}</small> · 대실적 ${number(focused?.maxPv)} / 소실적 ${number(focused?.minPv)}</span><div>${parent ? '<button class="secondary compact" id="boxUp" type="button">상위 회원으로</button>' : ""}${focused && roots[0] && String(focused.userId) !== String(roots[0].userId) ? '<button class="secondary compact" id="boxTop" type="button">맨 위로</button>' : ""}</div>`;
    $("boxStage").innerHTML = focused
      ? boxTreeHtml(
          { byId, children },
          focused.userId,
          { depth, totalOf: lineTotal, selectedId },
        )
      : '<p class="help">표시할 회원이 없습니다.</p>';
    if ($("boxUp"))
      $("boxUp").onclick = () => {
        focused = parent;
        selectedId = String(parent.userId);
        render();
      };
    if ($("boxTop"))
      $("boxTop").onclick = () => {
        focused = roots[0];
        selectedId = String(roots[0].userId);
        render();
      };
    bindNodes();
    centerView();
  };

  const centerView = () => {
    const canvas = root.querySelector(".pannable-tree");
    if (!canvas) return;
    canvas.scrollLeft = Math.max(
      0,
      (canvas.scrollWidth - canvas.clientWidth) / 2,
    );
    canvas.scrollTop = 0;
  };

  const setZoom = (value) => {
    zoom = Math.min(1.6, Math.max(0.4, Number(value.toFixed(2))));
    $("boxStage").style.zoom = zoom;
    $("boxZoomReset").textContent = `${Math.round(zoom * 100)}%`;
    centerView();
  };
  $("boxZoomOut").onclick = () => setZoom(zoom - 0.1);
  $("boxZoomIn").onclick = () => setZoom(zoom + 0.1);
  $("boxZoomReset").onclick = () => setZoom(1);
  $("boxDepth").onchange = () => {
    depth = Number($("boxDepth").value);
    render();
  };
  $("boxSearch").oninput = render;
  $("boxPrint").onclick = () => {
    document.body.classList.add("printing-tree");
    window.print();
    setTimeout(() => document.body.classList.remove("printing-tree"), 500);
  };

  const canvas = root.querySelector(".pannable-tree");
  let active = false,
    moved = false,
    captured = false,
    startX = 0,
    startY = 0,
    scrollLeft = 0,
    scrollTop = 0;
  canvas.onpointerdown = (event) => {
    if (event.button !== 0) return;
    active = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    scrollLeft = canvas.scrollLeft;
    scrollTop = canvas.scrollTop;
  };
  canvas.onpointermove = (event) => {
    if (!active) return;
    const dx = event.clientX - startX,
      dy = event.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) > 6) {
      moved = true;
      captured = true;
      canvas.classList.add("dragging");
      canvas.setPointerCapture(event.pointerId);
    }
    if (!moved) return;
    canvas.scrollLeft = scrollLeft - dx;
    canvas.scrollTop = scrollTop - dy;
  };
  const stop = (event) => {
    active = false;
    canvas.classList.remove("dragging");
    if (captured && canvas.hasPointerCapture(event.pointerId))
      canvas.releasePointerCapture(event.pointerId);
    captured = false;
  };
  canvas.onpointerup = stop;
  canvas.onpointercancel = stop;
  canvas.addEventListener(
    "click",
    (event) => {
      if (!moved) return;
      event.preventDefault();
      event.stopPropagation();
      moved = false;
    },
    true,
  );

  render();
}
