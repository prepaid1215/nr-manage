import { supabase } from "./supabase.js?v=20260829-34";
import { friendlyError } from "./errors.js?v=20260830-1";
import { branchBreakdown, buildPerformanceModel } from "./performance-calculator.js?v=20260831-61";
import { boxTreeHtml } from "./box-tree.js?v=20260831-60";

const safe = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
const date = (value) => value ? new Date(value).toLocaleString("ko-KR") : "기록 없음";
const pageNames = {
  home: "홈", customers: "고객", activity: "활동", checklist: "체크",
  organization: "조직", performance: "실적", commission: "수당",
  closing: "마감", team: "팀", settings: "설정", admin: "관리자",
};
const eventNames = { page_view: "화면 방문", action: "버튼 사용", submit: "저장/실행", error: "오류" };

export async function isAppAdmin() {
  const { data, error } = await supabase.rpc("is_app_admin");
  if (error) return false;
  return Boolean(data);
}

export async function adminPage(root) {
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>관리자 사용현황</h2><p class="help">가입자별 접속·수집·마감 사용 현황입니다. 비밀번호와 입력 내용은 기록하지 않습니다.</p></div><button id="adminReload" class="secondary compact" type="button">새로고침</button></div><div id="adminSummary" class="admin-summary"></div><label>사용자 검색<input id="adminSearch" type="search" placeholder="이름, 앱 아이디, 회원번호"></label><div id="adminError" class="error"></div></section><section class="card"><h2>가입자 현황</h2><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>사용자</th><th>최근 활동</th><th>최근 화면</th><th>수집 (성공/실패)</th><th>마감 계획</th></tr></thead><tbody id="adminUsers"></tbody></table></div></section><section class="card"><h2>최근 행동</h2><div id="adminEvents" class="admin-events"></div></section><dialog id="adminGenealogyDialog" class="member-dialog admin-genealogy-dialog"><div class="dialog-head"><h2 id="adminGenealogyTitle">사용자 계보도</h2><button class="secondary compact" id="adminGenealogyDownload" type="button" hidden>💾 JSON 다운로드</button><button id="adminGenealogyClose" type="button">×</button></div><div class="admin-genealogy-body"><p id="adminGenealogyMeta" class="help"></p><div id="adminPlanSummary" class="admin-plan-summary"></div><div id="adminGenealogyError" class="error"></div><div class="tree-focus-bar admin-tree-tools"><span>기준: <b id="adminTreeFocus">-</b></span><div><button class="secondary compact" id="adminTreeHome" type="button">맨 위로</button><button class="secondary compact" id="adminTreeUp" type="button">상위로</button><span class="tree-zoom-controls"><button class="secondary compact" id="adminZoomOut" type="button">−</button><button class="secondary compact" id="adminZoomReset" type="button">100%</button><button class="secondary compact" id="adminZoomIn" type="button">＋</button></span></div></div><p class="help">회원을 클릭하면 그 사람을 맨 위로 놓고 다시 그립니다. 빈 공간을 끌면 계보도가 이동합니다.</p><div id="adminGenealogyTree" class="box-tree pannable-tree"><div class="tree-stage" id="adminGenealogyStage"><p class="help">계보도를 불러오는 중...</p></div></div></div></dialog>`;
  const $ = (id) => document.getElementById(id);
  let users = [], genealogyModel = null, genealogyHomeId = null,
    genealogyFocusId = null, genealogyZoom = 1, genealogyPayload = null, genealogyPayloadName = "";
  const centerAdminTree = () => {
    const canvas = $("adminGenealogyTree");
    requestAnimationFrame(() => {
      canvas.scrollLeft = Math.max(0, (canvas.scrollWidth - canvas.clientWidth) / 2);
      canvas.scrollTop = 0;
    });
  };
  const renderAdminTree = () => {
    if (!genealogyModel || !genealogyFocusId) return;
    const focus = genealogyModel.byId.get(genealogyFocusId);
    $("adminTreeFocus").textContent = focus?.userName || genealogyFocusId;
    $("adminTreeUp").disabled = !focus?.ppId || !genealogyModel.byId.has(String(focus.ppId));
    $("adminGenealogyStage").style.zoom = genealogyZoom;
    $("adminGenealogyStage").innerHTML = boxTreeHtml(genealogyModel, genealogyFocusId, {
      depth: 10, hideDate: true, clickable: true,
      totalOf: (row) => branchBreakdown(row).total,
    });
    centerAdminTree();
  };
  const setAdminZoom = (value) => {
    genealogyZoom = Math.min(1.8, Math.max(0.4, Number(value.toFixed(2))));
    $("adminGenealogyStage").style.zoom = genealogyZoom;
    $("adminZoomReset").textContent = `${Math.round(genealogyZoom * 100)}%`;
    centerAdminTree();
  };
  const renderUsers = () => {
    const query = $("adminSearch").value.trim().toLowerCase();
    const filtered = users.filter((row) =>
      [row.name, row.username, row.member_no].some((value) => String(value || "").toLowerCase().includes(query)),
    );
    $("adminUsers").innerHTML = filtered.length
      ? filtered.map((row) => `<tr><td><b>${safe(row.name || "이름 없음")}</b><small>${safe(row.username || "-")} · ${safe(row.member_no || "회원번호 없음")}</small></td><td>${safe(date(row.last_seen_at))}<small>기록 ${Number(row.event_count || 0).toLocaleString()}건</small></td><td>${safe(pageNames[row.last_page] || row.last_page || "-")}</td><td>${safe(date(row.last_snapshot_at))}<small>총 ${Number(row.collection_count || 0).toLocaleString()}회 · 성공 ${Number(row.job_success_count || 0).toLocaleString()} · 실패 ${Number(row.job_error_count || 0).toLocaleString()}</small>${row.last_snapshot_at ? `<button class="secondary compact admin-tree-button" data-admin-user="${safe(row.user_id)}" type="button">계보도 보기</button>` : ""}</td><td>진행 ${Number(row.draft_plan_count || 0)} · 완료 ${Number(row.done_plan_count || 0)}</td></tr>`).join("")
      : '<tr><td colspan="5">일치하는 사용자가 없습니다.</td></tr>';
  };
  const load = async () => {
    $("adminError").textContent = "";
    const [usersResult, eventsResult] = await Promise.all([
      supabase.rpc("admin_user_overview"),
      supabase.rpc("admin_recent_events", { p_limit: 200 }),
    ]);
    const error = usersResult.error || eventsResult.error;
    if (error) {
      $("adminError").textContent = friendlyError(error, "관리자 현황을 불러오지 못했습니다. RUN_021을 먼저 실행해 주세요.");
      return;
    }
    users = usersResult.data || [];
    const events = eventsResult.data || [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const activeToday = users.filter((row) => row.last_seen_at && new Date(row.last_seen_at) >= today).length;
    const errorsToday = events.filter((row) => row.event_type === "error" && new Date(row.created_at) >= today).length;
    const totalCollections = users.reduce((sum, row) => sum + Number(row.collection_count || 0), 0);
    const totalCollectionErrors = users.reduce((sum, row) => sum + Number(row.job_error_count || 0), 0);
    $("adminSummary").innerHTML = `<article><span>전체 가입자</span><b>${users.length}명</b></article><article><span>오늘 활동</span><b>${activeToday}명</b></article><article><span>최근 오류</span><b>${errorsToday}건</b></article><article><span>전체 수집</span><b>${totalCollections.toLocaleString()}회</b></article><article><span>수집 실패</span><b>${totalCollectionErrors.toLocaleString()}건</b></article>`;
    renderUsers();
    $("adminEvents").innerHTML = events.length
      ? events.map((row) => {
          const isError = row.event_type === "error";
          const detailMessage = [row.detail?.name, row.detail?.message].filter(Boolean).join(": ");
          return `<article${isError ? ' class="admin-event-error"' : ""}><time>${safe(date(row.created_at))}</time><b>${safe(row.user_name || row.username || "사용자")}</b><span>${safe(eventNames[row.event_type] || row.event_type)} · ${safe(pageNames[row.page] || row.page || "-")}${row.action ? ` · ${safe(row.action)}` : ""}</span>${isError && detailMessage ? `<small class="error">${safe(detailMessage)}</small>` : ""}</article>`;
        }).join("")
      : '<p class="help">아직 기록된 행동이 없습니다.</p>';
  };
  $("adminSearch").oninput = renderUsers;
  $("adminReload").onclick = load;
  $("adminGenealogyClose").onclick = () => $("adminGenealogyDialog").close();
  $("adminGenealogyDownload").onclick = () => {
    if (!genealogyPayload) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(genealogyPayload, null, 2)], { type: "application/json;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${genealogyPayloadName || "collected-data"}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  $("adminUsers").onclick = async (event) => {
    const button = event.target.closest("[data-admin-user]");
    if (!button) return;
    const user = users.find((row) => row.user_id === button.dataset.adminUser);
    $("adminGenealogyTitle").textContent = `${user?.name || "사용자"} 계보도`;
    $("adminGenealogyMeta").textContent = "최신 수집 데이터와 마감 계획을 불러오는 중...";
    $("adminPlanSummary").innerHTML = "";
    $("adminGenealogyError").textContent = "";
    $("adminGenealogyStage").innerHTML = '<p class="help">계보도를 불러오는 중...</p>';
    $("adminGenealogyDownload").hidden = true;
    genealogyPayload = null;
    $("adminGenealogyDialog").showModal();
    const [snapshotResult, plansResult] = await Promise.all([
      supabase.rpc("admin_user_latest_snapshot", { p_user_id: button.dataset.adminUser }),
      supabase.rpc("admin_user_closing_plans", { p_user_id: button.dataset.adminUser }),
    ]);
    const error = snapshotResult.error || plansResult.error;
    if (error) {
      $("adminGenealogyError").textContent = friendlyError(error, "계보 데이터를 불러오지 못했습니다. RUN_022를 먼저 실행해 주세요.");
      $("adminGenealogyStage").innerHTML = "";
      return;
    }
    const snapshot = snapshotResult.data?.[0];
    if (!snapshot) {
      $("adminGenealogyMeta").textContent = "수집된 계보 데이터가 없습니다.";
      $("adminGenealogyStage").innerHTML = "";
      return;
    }
    try {
      const payload = typeof snapshot.payload === "string" ? JSON.parse(snapshot.payload) : snapshot.payload;
      genealogyPayload = payload;
      genealogyPayloadName = `${user?.name || "사용자"}-${(user?.username || snapshot.source_account_id || "data")}-${String(snapshot.collected_at || "").slice(0, 10)}`;
      $("adminGenealogyDownload").hidden = false;
      const model = buildPerformanceModel(payload);
      const rootId = [user?.member_no, snapshot.source_account_id, model.rows[0]?.userId]
        .map(String).find((id) => model.byId.has(id));
      $("adminGenealogyMeta").textContent = `수집 ${date(snapshot.collected_at)} · NRC 계정 ${snapshot.source_account_id || "-"} · 계보 ${model.rows.length.toLocaleString()}명`;
      const plans = plansResult.data || [];
      $("adminPlanSummary").innerHTML = plans.length
        ? plans.map((plan) => `<article><b>${safe(plan.top_member_id)} · ${plan.status === "DONE" ? "완료" : "진행"}</b><span>목표 대 ${Number(plan.top_major_target || 0).toLocaleString()} / 소 ${Number(plan.top_minor_target || 0).toLocaleString()} NV</span><span>결과 대 ${Number(plan.top_major_nv || 0).toLocaleString()} / 소 ${Number(plan.top_minor_nv || 0).toLocaleString()} NV</span></article>`).join("")
        : '<p class="help">저장된 마감 계획이 없습니다.</p>';
      genealogyModel = model;
      genealogyHomeId = rootId;
      genealogyFocusId = rootId;
      genealogyZoom = 1;
      $("adminZoomReset").textContent = "100%";
      renderAdminTree();
    } catch (parseError) {
      $("adminGenealogyError").textContent = friendlyError(parseError, "계보 데이터 형식을 읽지 못했습니다.");
      $("adminGenealogyStage").innerHTML = "";
    }
  };
  $("adminTreeHome").onclick = () => { genealogyFocusId = genealogyHomeId; renderAdminTree(); };
  $("adminTreeUp").onclick = () => {
    const parentId = genealogyModel?.byId.get(genealogyFocusId)?.ppId;
    if (parentId && genealogyModel.byId.has(String(parentId))) {
      genealogyFocusId = String(parentId); renderAdminTree();
    }
  };
  $("adminZoomOut").onclick = () => setAdminZoom(genealogyZoom - 0.1);
  $("adminZoomIn").onclick = () => setAdminZoom(genealogyZoom + 0.1);
  $("adminZoomReset").onclick = () => setAdminZoom(1);
  $("adminGenealogyTree").onclick = (event) => {
    const node = event.target.closest("[data-member]");
    if (node && genealogyModel?.byId.has(node.dataset.member)) {
      genealogyFocusId = node.dataset.member; renderAdminTree();
    }
  };
  const canvas = $("adminGenealogyTree");
  let panActive = false, panMoved = false, panCaptured = false,
    panX = 0, panY = 0, panLeft = 0, panTop = 0;
  canvas.onpointerdown = (event) => {
    if (event.button !== 0) return;
    panActive = true; panMoved = false; panX = event.clientX; panY = event.clientY;
    panLeft = canvas.scrollLeft; panTop = canvas.scrollTop;
  };
  canvas.onpointermove = (event) => {
    if (!panActive) return;
    const dx = event.clientX - panX, dy = event.clientY - panY;
    if (!panMoved && Math.abs(dx) + Math.abs(dy) > 6) {
      panMoved = true; panCaptured = true; canvas.classList.add("dragging");
      canvas.setPointerCapture(event.pointerId);
    }
    if (panMoved) { canvas.scrollLeft = panLeft - dx; canvas.scrollTop = panTop - dy; }
  };
  const stopPan = (event) => {
    panActive = false; canvas.classList.remove("dragging");
    if (panCaptured && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    panCaptured = false;
  };
  canvas.onpointerup = stopPan;
  canvas.onpointercancel = stopPan;
  canvas.addEventListener("click", (event) => {
    if (!panMoved) return;
    event.preventDefault(); event.stopPropagation(); panMoved = false;
  }, true);
  await load();
}
