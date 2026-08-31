import {
  supabase,
  signUp,
  signIn,
  currentProfile,
  setRememberLogin,
} from "./supabase.js?v=20260829-34";
import { customersPage } from "./customers.js?v=20260829-24";
import { activityPage } from "./activity.js?v=20260829-25";
import {
  checklistItemCount,
  checklistPage,
} from "./checklist.js?v=20260829-29";
import { closingPage, commissionPage } from "./finance.js?v=20260829-28";
import { performancePage } from "./performance.js?v=20260829-73";
import { teamPage } from "./team.js?v=20260829-35";
import { localDate, monthRange } from "./date.js?v=20260829-25";
import { friendlyError } from "./errors.js?v=20260830-1";
import { adminPage, isAppAdmin } from "./admin.js?v=20260830-3";
import {
  installInteractionTracking,
  setTelemetryPage,
  setTelemetryUser,
  trackEvent,
} from "./telemetry.js?v=20260830-1";
const $ = (id) => document.getElementById(id);
let me = null,
  authMode = "login",
  appAdmin = false,
  trackingInstalled = false;
const menus = [
  ["home", "홈"],
  ["customers", "고객"],
  ["activity", "활동"],
  ["checklist", "체크"],
  ["organization", "조직"],
  ["performance", "실적"],
  ["commission", "수당"],
  ["closing", "마감"],
  ["team", "팀"],
  ["settings", "설정"],
  ["admin", "관리자"],
];
const visibleMenus = () => menus.filter(([id]) => id !== "admin" || appAdmin);
function nav() {
  const html = visibleMenus()
    .map(([id, label]) => `<button data-page="${id}">${label}</button>`)
    .join("");
  $("topNav").innerHTML = html;
  $("bottomNav").innerHTML = menus
    .slice(0, 4)
    .concat([["more", "더보기"]])
    .map(([id, label]) => `<button data-page="${id}">${label}</button>`)
    .join("");
  document
    .querySelectorAll("[data-page]")
    .forEach((b) => (b.onclick = () => show(b.dataset.page)));
}
async function quickAmountEntry(field, label) {
  const raw = prompt(`${label} 금액(원)을 입력하세요.`, "");
  if (raw === null) return;
  const amount = Number(String(raw).replace(/[^0-9]/g, ""));
  if (!amount) return;
  const date = localDate();
  const { data: existing } = await supabase
    .from("daily_activities")
    .select(field)
    .eq("owner_id", me.id)
    .eq("activity_date", date)
    .maybeSingle();
  const next = Number(existing?.[field] || 0) + amount;
  await supabase.from("daily_activities").upsert(
    {
      owner_id: me.id,
      activity_date: date,
      [field]: next,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "owner_id,activity_date" },
  );
  await home();
}
async function home() {
  const frag = $("homeTemplate").content.cloneNode(true);
  $("content").replaceChildren(frag);
  $("content").insertAdjacentHTML(
    "afterbegin",
    `<section class="card home-actions"><button class="primary" id="homeAddCustomer" type="button">+ 고객 등록</button><div class="customer-quick-actions"><button class="secondary compact" id="homeQuickTransfer" type="button">+ 신규개통양도</button><button class="secondary compact" id="homeQuickRepurchase" type="button">+ 재구매양도</button></div></section>`,
  );
  $("content").querySelector(".kpis").insertAdjacentHTML(
    "afterend",
    `<section class="card home-nrc"><div class="section-head"><div><h2>NRC 매출 대시보드</h2><p class="help" id="homeNrcUpdated">최근 수집 데이터를 불러오는 중...</p></div></div><div id="homePcStatus" class="pc-status-badge"><span class="device-dot"></span><span>수집 PC 상태 확인 중...</span></div><div id="homeCollectStatus" class="connection-status" hidden></div><div id="homeCollectError" class="error"></div><button class="secondary home-collect-btn" id="homeCollect" type="button">매출받기 (마감할 때만 눌러도 됩니다)</button><div id="homeNrcDashboard"><p class="help">수집된 매출 데이터가 없습니다.</p></div></section>`,
  );
  loadHomePcStatus();
  $("content").insertAdjacentHTML(
    "beforeend",
    `<section class="card"><h2>알림</h2><div id="homeAlerts" class="home-alerts"><p class="help">알림을 불러오는 중...</p></div></section>`,
  );
  $("homeCollect").onclick = runHomeCollection;
  $("homeAddCustomer").onclick = () => show("customers", { openAdd: true });
  $("homeQuickTransfer").onclick = () =>
    quickAmountEntry("new_transfer", "신규개통양도");
  $("homeQuickRepurchase").onclick = () =>
    quickAmountEntry("repurchase", "재구매양도");
  const date = new Date(),
    today = localDate(date),
    month = today.slice(0, 7),
    { start, end } = monthRange(month),
    [customers, activity, checks, closing, commissions, snapshot] =
      await Promise.all([
        supabase.from("customers").select("*").eq("owner_id", me.id),
        supabase
          .from("daily_activities")
          .select("*")
          .eq("owner_id", me.id)
          .gte("activity_date", start)
          .lte("activity_date", end)
          .order("activity_date", { ascending: true }),
        supabase.from("checklist_progress").select("*").eq("owner_id", me.id),
        supabase
          .from("closing_sales")
          .select("*")
          .eq("owner_id", me.id)
          .eq("year", date.getFullYear())
          .eq("month", date.getMonth() + 1),
        supabase
          .from("commissions")
          .select("*")
          .eq("owner_id", me.id)
          .eq("year", date.getFullYear())
          .eq("month", date.getMonth() + 1),
        supabase
          .from("nrc_sync_snapshots")
          .select("source_account_id,payload,collected_at")
          .eq("snapshot_type", "combined")
          .order("collected_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
  const failed = [customers, activity, checks, closing, commissions, snapshot]
    .map((result) => result.error)
    .find(Boolean);
  if (failed) {
    $("homeAlerts").innerHTML =
      `<article>⚠️ ${safe(friendlyError(failed, "데이터를 불러오지 못했습니다. 잠시 후 새로고침해 주세요."))}</article>`;
    return;
  }
  const cs = customers.data || [],
    acts = activity.data || [],
    todayAct = acts.find((r) => r.activity_date === today),
    monthActivation = cs.filter((c) =>
      c.activation_date?.startsWith(month),
    ).length;
  if (snapshot.data) {
    const payload =
        typeof snapshot.data.payload === "string"
          ? JSON.parse(snapshot.data.payload)
          : snapshot.data.payload || {},
      salesRows = payload.members || [],
      treeRows = payload.rstLst || [],
      memberNo = String(me.member_no || snapshot.data.source_account_id || ""),
      sale =
        salesRows.find((item) => String(item.userId) === memberNo) ||
        salesRows[0] ||
        {},
      tree =
        treeRows.find((item) => String(item.userId) === memberNo) ||
        treeRows[0] ||
        {},
      own = Number(sale.ordPv ?? tree.ordPv ?? 0),
      major = Number(sale.maxPv ?? tree.maxPv ?? 0),
      minor = Number(sale.minPv ?? tree.minPv ?? 0),
      rank = sale.rankName || tree.rankName || "회원",
      certified = sale.rankMaxName || tree.rankMaxName || "회원";
    const consumer = payload.consumerSummary || null;
    $("homeNrcUpdated").textContent =
      `최종 업데이트 ${new Date(snapshot.data.collected_at).toLocaleString("ko-KR")}`;
    $("homeNrcDashboard").innerHTML =
      `<div class="nrc-overview"><article><h3>본인 매출 현황</h3><div><span>본인매출 NV<b>${number(own)}</b></span><span>대실적<b>${number(major)}</b></span><span>소실적<b>${number(minor)}</b></span></div></article><article><h3>직급 현황</h3><div><span>현재직급<b>${safe(rank)}</b></span><span>인증직급<b>${safe(certified)}</b></span></div></article><article><h3>소비자회선 현황</h3><div class="consumer-kpis"><span>총회선<b>${consumer ? number(consumer["총회선"]) : "미수집"}</b></span><span>실인증회선<b>${consumer ? number(consumer["실인증회선"]) : "-"}</b></span><span>실회선<b>${consumer ? number(consumer["실회선"]) : "-"}</b></span><span>KT / LG<b>${consumer ? `${number(consumer["KT망"])} / ${number(consumer["LG망"])}` : "-"}</b></span></div></article><article><h3>조직 현황</h3><div><span>전체 회원<b>${treeRows.length.toLocaleString()}명</b></span><span>활동 회원<b>${treeRows.filter((item) => String(item.status) === "1" && !item.dormant).length.toLocaleString()}명</b></span></div></article></div><div class="nrc-gauges"><article><div class="nrc-gauge major"><span>대실적<b>${number(major)}</b></span></div></article><article><div class="nrc-gauge minor"><span>소실적<b>${number(minor)}</b></span></div></article></div>`;
  }
  $("todayActivations").textContent =
    `${cs.filter((c) => c.activation_date === today).length}건`;
  $("newTransfer").textContent =
    `${Number(todayAct?.new_transfer || 0).toLocaleString()}원`;
  $("repurchase").textContent =
    `${Number(todayAct?.repurchase || 0).toLocaleString()}원`;
  $("balance").textContent =
    `${Number(todayAct?.balance || 0).toLocaleString()}원`;
  $("attendance").textContent = `${Number(todayAct?.attendance || 0)}명`;
  $("monthlySummary").textContent =
    `개통 ${monthActivation}건 · 포스팅 ${acts.reduce((s, r) => s + Object.values(r.content?.postings || {}).reduce((a, b) => a + Number(b || 0), 0), 0)}건 · 마감매출 ${(closing.data || []).reduce((s, r) => s + Number(r.closing_sales || 0), 0).toLocaleString()}원 · 수당 ${(commissions.data || []).reduce((s, r) => s + Number(r.amount || 0), 0).toLocaleString()}원`;
  const tasks = (todayAct?.tasks || []).filter(Boolean);
  $("todayTasks").innerHTML = tasks.length
    ? tasks.map((t) => `<li>${safe(t)}</li>`).join("")
    : "<li>오늘 할 일이 등록되지 않았습니다.</li>";
  const alerts = [];
  if (!todayAct) alerts.push("오늘 일일업무일지가 없습니다.");
  const completedKeys = new Set(
      (checks.data || []).filter((r) => r.checked).map((r) => r.item_key),
    ),
    incomplete = Math.max(0, checklistItemCount - completedKeys.size);
  if (incomplete) alerts.push(`미완료 체크리스트 ${incomplete}개가 있습니다.`);
  const old =
    snapshot.data?.collected_at &&
    Date.now() - new Date(snapshot.data.collected_at) > 86400000;
  if (!snapshot.data) alerts.push("수집된 NRC JSON이 없습니다.");
  else if (old) alerts.push("NRC JSON이 24시간 이상 업데이트되지 않았습니다.");
  $("homeAlerts").innerHTML = alerts.length
    ? alerts.map((a) => `<article>🔔 ${a}</article>`).join("")
    : '<p class="help">현재 긴급한 알림이 없습니다.</p>';
}
async function show(page, options) {
  if (page === "admin" && !appAdmin) page = "home";
  setTelemetryPage(page);
  trackEvent("page_view", page);
  document
    .querySelectorAll("[data-page]")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  if (page === "home") return home();
  if (page === "customers") return customersPage($("content"), me, options);
  if (page === "activity") return activityPage($("content"), me);
  if (page === "checklist") return checklistPage($("content"), me);
  if (page === "organization") return organizationDashboard();
  if (page === "performance") return performancePage($("content"), me);
  if (page === "commission") return commissionPage($("content"), me);
  if (page === "closing") return closingPage($("content"), me);
  if (page === "team") return teamPage($("content"), me);
  if (page === "settings") return settings();
  if (page === "admin") return adminPage($("content"));
  $("content").innerHTML =
    `<section class="card"><h2>더보기</h2><p class="help">전체 메뉴가 아래에 있습니다. PC와 모바일 어디서나 똑같이 사용할 수 있습니다.</p><div class="more-menu">${visibleMenus()
      .slice(4)
      .map(([id, label]) => `<button data-page="${id}" type="button">${label}</button>`)
      .join("")}</div></section>`;
  $("content")
    .querySelectorAll("[data-page]")
    .forEach((b) => (b.onclick = () => show(b.dataset.page)));
}
async function organization() {
  $("content").innerHTML =
    `<section class="card"><div class="section-head"><div><h2>10단계 조직 현황</h2><p class="help" id="orgCollected">최신 수집 데이터를 불러오는 중...</p></div><button class="secondary compact" id="orgReload" type="button">새로고침</button></div><div class="org-summary" id="orgSummary"></div><label>회원 검색<input id="orgSearch" type="search" placeholder="이름 또는 회원번호"></label><div class="depth-filter" id="depthFilter"></div><div id="orgError" class="error"></div><div id="orgTree" class="org-tree"></div></section>`;
  $("orgReload").onclick = organization;
  try {
    const { data, error } = await supabase
      .from("nrc_sync_snapshots")
      .select("source_account_id,payload,collected_at")
      .eq("snapshot_type", "combined")
      .order("collected_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      $("orgCollected").textContent = "저장된 조직 데이터가 없습니다.";
      $("orgTree").innerHTML =
        '<p class="help">PC의 수집 탭에서 먼저 JSON을 수집하세요.</p>';
      return;
    }
    const payload =
      typeof data.payload === "string"
        ? JSON.parse(data.payload)
        : data.payload;
    const sales = new Map(
      (payload.members || []).map((item) => [String(item.userId), item]),
    );
    const rows = (payload.rstLst || []).map((item) => ({
      ...item,
      ...(sales.get(String(item.userId)) || {}),
    }));
    const maxDepth = Math.max(0, ...rows.map((item) => Number(item.lv) || 0));
    $("orgCollected").textContent =
      `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · NRC ${data.source_account_id || "-"}`;
    $("orgSummary").innerHTML =
      `<article><span>전체 회원</span><b>${rows.length.toLocaleString()}명</b></article><article><span>최대 단계</span><b>${maxDepth}단계</b></article><article><span>활동 회원</span><b>${rows.filter((item) => String(item.status) === "1" && !item.dormant).length.toLocaleString()}명</b></article>`;
    $("depthFilter").innerHTML =
      `<button class="active" data-depth="all">전체</button>${Array.from({ length: maxDepth + 1 }, (_, depth) => `<button data-depth="${depth}">${depth}단계</button>`).join("")}`;
    let depth = "all";
    const render = () => {
      const query = $("orgSearch").value.trim().toLowerCase();
      const filtered = rows.filter(
        (item) =>
          (depth === "all" || String(item.lv) === depth) &&
          (!query ||
            String(item.userName || "")
              .toLowerCase()
              .includes(query) ||
            String(item.userId || "").includes(query)),
      );
      $("orgTree").innerHTML = filtered.length
        ? filtered
            .map(
              (item) =>
                `<article class="org-member" style="--depth:${Math.min(Number(item.lv) || 0, 10)}"><div class="org-person"><span class="depth-badge">${Number(item.lv) || 0}</span><div><b>${safe(item.userName || "이름 없음")}</b><small>${safe(item.userId)} · ${safe(item.rankName || "회원")} / ${safe(item.rankMaxName || "회원")}</small></div></div><div class="org-nv"><span>본인 NV<b>${number(item.ordPv)}</b></span><span>대실적<b>${number(item.maxPv)}</b></span><span>소실적<b>${number(item.minPv)}</b></span></div></article>`,
            )
            .join("")
        : '<p class="help">검색 결과가 없습니다.</p>';
    };
    $("orgSearch").oninput = render;
    $("depthFilter")
      .querySelectorAll("button")
      .forEach(
        (button) =>
          (button.onclick = () => {
            depth = button.dataset.depth;
            $("depthFilter")
              .querySelectorAll("button")
              .forEach((item) =>
                item.classList.toggle("active", item === button),
              );
            render();
          }),
      );
    render();
  } catch (err) {
    $("orgCollected").textContent = "조직 데이터를 불러오지 못했습니다.";
    $("orgError").textContent = friendlyError(err);
  }
}
const number = (value) => Number(value || 0).toLocaleString("ko-KR");
async function organizationTree() {
  $("content").innerHTML =
    `<section class="card genealogy-card"><div class="section-head"><div><h2>10단계 계보도</h2><p class="help" id="orgCollected">최신 데이터를 불러오는 중...</p></div><button class="secondary compact" id="orgReload" type="button">새로고침</button></div><div class="org-summary" id="orgSummary"></div><label>회원 검색<input id="orgSearch" type="search" placeholder="이름 또는 회원번호"></label><div id="orgError" class="error"></div><div id="genealogy" class="genealogy"></div></section><dialog id="memberDialog" class="member-dialog"><div class="dialog-head"><h2>본인 매출 현황</h2><button id="closeMember" type="button" aria-label="닫기">×</button></div><div id="memberDetail"></div></dialog>`;
  $("orgReload").onclick = organizationTree;
  try {
    const { data, error } = await supabase
      .from("nrc_sync_snapshots")
      .select("source_account_id,payload,collected_at")
      .eq("snapshot_type", "combined")
      .order("collected_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      $("orgCollected").textContent = "저장된 조직 데이터가 없습니다.";
      $("genealogy").innerHTML =
        '<p class="help">수집 탭에서 먼저 JSON을 저장하세요.</p>';
      return;
    }
    const payload =
      typeof data.payload === "string"
        ? JSON.parse(data.payload)
        : data.payload;
    const sales = new Map(
      (payload.members || []).map((item) => [String(item.userId), item]),
    );
    const rows = (payload.rstLst || []).map((item) => ({
      ...item,
      ...(sales.get(String(item.userId)) || {}),
    }));
    const byId = new Map(rows.map((item) => [String(item.userId), item]));
    const consumerByMember = payload.consumerByMember || {};
    const children = new Map();
    rows.forEach((item) => {
      const parent = String(item.ppId || "");
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(item);
    });
    const roots = rows.filter(
      (item) => !item.ppId || !byId.has(String(item.ppId)),
    );
    const maxDepth = Math.max(0, ...rows.map((item) => Number(item.lv) || 0));
    $("orgCollected").textContent =
      `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · NRC ${data.source_account_id || "-"}`;
    $("orgSummary").innerHTML =
      `<article><span>전체 회원</span><b>${rows.length.toLocaleString()}명</b></article><article><span>최대 단계</span><b>${maxDepth}단계</b></article><article><span>활동 회원</span><b>${rows.filter((item) => String(item.status) === "1" && !item.dormant).length.toLocaleString()}명</b></article>`;
    const node = (item) =>
      `<li><button class="genealogy-node" data-member="${safe(item.userId)}" type="button"><span class="depth-badge">${Number(item.lv) || 0}</span><span><b>${safe(item.userName || "이름 없음")}</b><small>${safe(item.userId)} · ${safe(item.rankName || "회원")}</small></span><em>${number(item.ordPv)} NV</em></button>${(children.get(String(item.userId)) || []).length ? `<ul>${(children.get(String(item.userId)) || []).map(node).join("")}</ul>` : ""}</li>`;
    const openDetail = (item) => {
      const parent = byId.get(String(item.ppId || ""));
      $("memberDetail").innerHTML =
        `<table class="detail-table"><tbody><tr><th>성명</th><td>${safe(item.userName || "—")}</td><th>회원번호</th><td>${safe(item.userId || "—")}</td></tr><tr><th>현재직급</th><td>${safe(item.rankName || "회원")}</td><th>인증직급</th><td>${safe(item.rankMaxName || "회원")}</td></tr><tr><th>본인매출 NV</th><td>${number(item.ordPv)}</td><th>정산 적용 NV</th><td>${number(item.ordPv)}</td></tr><tr><th>대실적(실시간)</th><td>${number(item.maxPv)}</td><th>소실적(실시간)</th><td>${number(item.minPv)}</td></tr><tr><th>상위회원</th><td>${parent ? safe(parent.userName) : "—"}</td><th>계보 단계</th><td>${Number(item.lv) || 0}단계</td></tr><tr><th>활동 상태</th><td>${item.dormant ? "휴면" : String(item.status) === "1" ? "활동" : "비활동"}</td><th>가입일</th><td>${safe(item.regDate || "—")}</td></tr></tbody></table><p class="detail-note">※ 현재 수집 JSON에 존재하는 값만 표시합니다.</p>`;
      $("memberDialog").showModal();
    };
    const bindNodes = () =>
      document
        .querySelectorAll(".genealogy-node")
        .forEach(
          (button) =>
            (button.onclick = () =>
              openDetail(byId.get(button.dataset.member))),
        );
    const renderTree = () => {
      $("genealogy").innerHTML =
        `<ul class="genealogy-root">${roots.map(node).join("")}</ul>`;
      bindNodes();
    };
    $("orgSearch").oninput = () => {
      const query = $("orgSearch").value.trim().toLowerCase();
      if (!query) return renderTree();
      const matches = rows.filter(
        (item) =>
          String(item.userName || "")
            .toLowerCase()
            .includes(query) || String(item.userId || "").includes(query),
      );
      $("genealogy").innerHTML = matches.length
        ? `<div class="genealogy-search">${matches.map((item) => `<button class="genealogy-node" data-member="${safe(item.userId)}" type="button"><span class="depth-badge">${Number(item.lv) || 0}</span><span><b>${safe(item.userName || "이름 없음")}</b><small>${safe(item.userId)} · ${safe(item.rankName || "회원")}</small></span><em>${number(item.ordPv)} NV</em></button>`).join("")}</div>`
        : '<p class="help">검색 결과가 없습니다.</p>';
      bindNodes();
    };
    $("closeMember").onclick = () => $("memberDialog").close();
    $("memberDialog").onclick = (event) => {
      if (event.target === $("memberDialog")) $("memberDialog").close();
    };
    renderTree();
  } catch (err) {
    $("orgCollected").textContent = "계보도를 불러오지 못했습니다.";
    $("orgError").textContent = friendlyError(err);
  }
}
async function organizationDashboard(targetOwner) {
  $("content").innerHTML =
    `<section class="card"><div class="section-head"><div><h2>${targetOwner ? `${safe(targetOwner.name)}의 조직 현황` : "조직 현황"}</h2><p class="help" id="orgCollected">최신 데이터를 불러오는 중...</p></div><button class="secondary compact" id="orgReload" type="button">새로고침</button></div>${targetOwner ? `<button class="secondary compact" id="orgBack" type="button">← 내 조직으로</button>` : ""}<div class="view-tabs"><button class="active" data-view="list" type="button">하위 매출 현황</button><button data-view="tree" type="button">계보도</button></div><div class="org-summary" id="orgSummary"></div><label>회원 검색<input id="orgSearch" type="search" placeholder="이름 또는 회원번호"></label><div class="depth-filter" id="depthFilter" hidden></div><div id="orgError" class="error"></div><section class="card member-sales-card member-sales-inline"><h2>선택 회원 매출 현황</h2><div id="memberDetailInline"><p class="help">회원 이름을 선택하세요.</p></div></section><div id="orgView"></div></section>`;
  $("orgReload").onclick = () => organizationDashboard(targetOwner);
  if (targetOwner)
    $("orgBack").onclick = () => organizationDashboard();
  try {
    const { data, error } = await supabase
      .from("nrc_sync_snapshots")
      .select("source_account_id,payload,collected_at")
      .eq("owner_id", targetOwner?.id || me.id)
      .eq("snapshot_type", "combined")
      .order("collected_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      $("orgCollected").textContent = "저장된 조직 데이터가 없습니다.";
      $("orgView").innerHTML =
        '<p class="help">수집 탭에서 먼저 JSON을 저장하세요.</p>';
      return;
    }
    const payload =
      typeof data.payload === "string"
        ? JSON.parse(data.payload)
        : data.payload;
    const sales = new Map(
      (payload.members || []).map((item) => [String(item.userId), item]),
    );
    const rows = (payload.rstLst || []).map((item) => ({
      ...item,
      ...(sales.get(String(item.userId)) || {}),
    }));
    const byId = new Map(rows.map((item) => [String(item.userId), item]));
    const consumerByMember = payload.consumerByMember || {};
    const children = new Map();
    rows.forEach((item) => {
      const parent = String(item.ppId || "");
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(item);
    });
    const roots = rows.filter(
      (item) => !item.ppId || !byId.has(String(item.ppId)),
    );
    const maxDepth = Math.max(0, ...rows.map((item) => Number(item.lv) || 0));
    let currentView = "list",
      depth = "all",
      selected = rows[0] || null,
      focusedRoot = null,
      treeZoom = 1;
    $("orgCollected").textContent =
      `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · NRC ${data.source_account_id || "-"}`;
    $("orgSummary").innerHTML =
      `<article><span>전체 회원</span><b>${rows.length.toLocaleString()}명</b></article><article><span>최대 단계</span><b>${maxDepth}단계</b></article><article><span>활동 회원</span><b>${rows.filter((item) => String(item.status) === "1" && !item.dormant).length.toLocaleString()}명</b></article>`;
    $("depthFilter").innerHTML =
      `<button class="active" data-depth="all">전체</button>${Array.from({ length: maxDepth + 1 }, (_, value) => `<button data-depth="${value}">${value}단계</button>`).join("")}`;
    const detail = (item) => {
      if (!item) return;
      selected = item;
      const parent = byId.get(String(item.ppId || "")),
        userId = String(item.userId || ""),
        consumer =
          consumerByMember[userId] ||
          Object.entries(consumerByMember).find(([memberCode]) => {
            const suffix = String(memberCode).replace(/\D/g, "");
            return suffix.length >= 4 && userId.endsWith(suffix);
          })?.[1] ||
          null,
        detailTotal = item.lineMetricsFound
          ? Number(item.consumerTotalLines || 0)
          : consumer?.["총회선"],
        detailKt = consumer?.["KT망"],
        detailLg = consumer?.["LG망"],
        lineSource = consumer
          ? "로그인 계정 회선 목록"
          : item.lineMetricsFound
            ? "회원 상세 응답"
            : "해당 회원 계정 수집 필요";
      $("memberDetailInline").innerHTML =
        `<table class="detail-table inline"><tbody><tr><th>성명</th><td>${safe(item.userName || "—")}</td><th>회원번호</th><td>${safe(item.userId || "—")}</td></tr><tr><th>현재직급</th><td>${safe(item.rankName || "회원")}</td><th>인증직급</th><td>${safe(item.rankMaxName || "회원")}</td></tr><tr><th>본인매출 NV</th><td>${number(item.ordPv)}</td><th>정산 적용 NV</th><td>${number(item.ordPv)}</td></tr><tr><th>대실적(실시간)</th><td>${number(item.maxPv)}</td><th>소실적(실시간)</th><td>${number(item.minPv)}</td></tr><tr><th>소비자 총회선</th><td>${detailTotal == null ? "해당 계정 수집 필요" : `${number(detailTotal)}회선`}</td><th>실회선</th><td>${item.lineMetricsFound ? `${number(item.realLines)}회선` : "—"}</td></tr><tr><th>본인 매출 회선</th><td>${item.lineMetricsFound ? `${number(item.ownSalesLines)}회선` : "—"}</td><th>정기배송 회선</th><td>${item.lineMetricsFound ? `${number(item.regularDeliveryLines)}회선` : "—"}</td></tr><tr><th>KT / LG 회선</th><td>${detailKt == null ? "해당 계정 수집 필요" : `${number(detailKt)} / ${number(detailLg)}`}</td><th>계보 단계</th><td>${Number(item.lv) || 0}단계</td></tr><tr><th>상위회원</th><td>${parent ? safe(parent.userName) : "—"}</td><th>활동 상태</th><td>${item.dormant ? "휴면" : String(item.status) === "1" ? "활동" : "비활동"}</td></tr><tr><th>가입일</th><td>${safe(item.regDate || "—")}</td><th>수집 기준</th><td>${lineSource}</td></tr></tbody></table><p class="detail-note">※ 소비자회선 목록은 NRC에서 현재 로그인한 계정 소유 데이터만 제공합니다. 하위회원 회선은 해당 회원 계정으로 수집하거나 팀 공유가 필요합니다.</p>${item.userId !== String(me.member_no || "") ? `<div class="detail-actions"><button class="secondary compact" data-view-customers="${safe(item.userId)}" data-view-name="${safe(item.userName || "")}" type="button">이 사업자 고객 보기</button><button class="secondary compact" data-view-tree="${safe(item.userId)}" data-view-name="${safe(item.userName || "")}" type="button">이 사업자 계보 보기</button></div>` : ""}`;
      const resolveMemberProfile = async (memberNo) => {
        const { data: target } = await supabase
          .from("profiles")
          .select("id,name")
          .eq("member_no", memberNo)
          .maybeSingle();
        if (!target)
          $("orgError").textContent =
            "해당 회원의 앱 계정을 찾을 수 없습니다(가입 안 했거나 회원번호 불일치).";
        return target;
      };
      $("memberDetailInline")
        .querySelector("[data-view-customers]")
        ?.addEventListener("click", async (event) => {
          const button = event.currentTarget;
          const target = await resolveMemberProfile(
            button.dataset.viewCustomers,
          );
          if (!target) return;
          show("customers", {
            viewOwner: {
              id: target.id,
              name: target.name || button.dataset.viewName,
            },
          });
        });
      $("memberDetailInline")
        .querySelector("[data-view-tree]")
        ?.addEventListener("click", async (event) => {
          const button = event.currentTarget;
          const target = await resolveMemberProfile(button.dataset.viewTree);
          if (!target) return;
          organizationDashboard({
            id: target.id,
            name: target.name || button.dataset.viewName,
          });
        });
    };
    const bind = () =>
      document.querySelectorAll("[data-member]").forEach(
        (button) =>
          (button.onclick = () => {
            const item = byId.get(button.dataset.member);
            detail(item);
            if (button.hasAttribute("data-tree-focus")) {
              focusedRoot = item;
              $("orgSearch").value = "";
              render();
              return;
            }
            document
              .querySelectorAll("[data-member]")
              .forEach((node) =>
                node.classList.toggle(
                  "selected",
                  node.dataset.member === button.dataset.member,
                ),
              );
          }),
      );
    const branchTotal = (item) =>
      Number(item?.ordPv || 0) +
      Number(item?.maxPv || 0) +
      Number(item?.minPv || 0);
    const treeNode = (item, path = new Set()) => {
      if (path.has(String(item.userId))) return "";
      const next = new Set(path);
      next.add(String(item.userId));
      const descendants = (children.get(String(item.userId)) || [])
        .filter((child) => (Number(child.lv) || 0) <= 10)
        .sort(
          (a, b) =>
            String(a.abPos || "").localeCompare(String(b.abPos || "")) ||
            String(a.userId).localeCompare(String(b.userId)),
        );
      const content = `<span class="sales-summary"><b>${safe(item.userName || "이름 없음")} <small>(${safe(item.userId || "코드 없음")}) (${safe(item.rankName || "회원")})</small></b><span>대실적 : <strong>${number(item.maxPv)}</strong></span><span>소실적 : <strong>${number(item.minPv)}</strong></span></span>`;
      if (!descendants.length) {
        return `<li><button class="family-node family-leaf" data-member="${safe(item.userId)}" type="button">${content}</button></li>`;
      }
      return `<li><details class="family-branch"><summary class="family-node" data-member="${safe(item.userId)}">${content}</summary><ul>${descendants.map((child) => treeNode(child, next)).join("")}</ul></details></li>`;
    };
    const horizontalTreeNode = (item, path = new Set()) => {
      if (path.has(String(item.userId))) return "";
      const next = new Set(path);
      next.add(String(item.userId));
      const descendants = (children.get(String(item.userId)) || [])
          .filter((child) => (Number(child.lv) || 0) <= 10)
          .sort(
            (a, b) =>
              String(a.abPos || "").localeCompare(String(b.abPos || "")) ||
              String(a.userId).localeCompare(String(b.userId)),
          ),
        sub1 = branchTotal(descendants[0]),
        sub2 = branchTotal(descendants[1]),
        content = `<b>${safe(item.userName || "이름 없음")}</b><small>*${safe(String(item.userId || "").slice(-6))} · ${safe(item.rankName || "회원")} / ${safe(item.rankMaxName || "회원")}</small><span class="family-own">본인 NV <strong>${number(item.ordPv)}</strong></span><span class="family-sales"><em>서브1 실적<strong>${number(sub1)}</strong></em><em>서브2 실적<strong>${number(sub2)}</strong></em><em>대실적<strong>${number(item.maxPv)}</strong></em><em>소실적<strong>${number(item.minPv)}</strong></em></span>`;
      return `<li><button class="family-node" data-member="${safe(item.userId)}" data-tree-focus type="button">${content}</button>${descendants.length ? `<ul>${descendants.map((child) => horizontalTreeNode(child, next)).join("")}</ul>` : ""}</li>`;
    };
    const render = () => {
      const query = $("orgSearch").value.trim().toLowerCase();
      if (currentView === "list" && !query) {
        $("orgView").innerHTML =
          `<div class="sales-tree"><ul>${roots.map((root) => treeNode(root)).join("")}</ul></div>`;
        bind();
        return;
      }
      if (currentView === "tree" && !query) {
        const displayRoots = focusedRoot ? [focusedRoot] : roots,
          parent = focusedRoot
            ? byId.get(String(focusedRoot.ppId || ""))
            : null;
        $("orgView").innerHTML =
          `<div class="tree-focus-bar"><span>기준: <b>${safe(focusedRoot?.userName || "전체 계보도")}</b></span><div>${focusedRoot ? '<button class="secondary compact" id="treeAll" type="button">전체 계보도</button>' : ""}${parent ? '<button class="secondary compact" id="treeUp" type="button">상위 회원으로</button>' : ""}<span class="tree-zoom-controls"><button class="secondary compact" id="treeZoomOut" type="button" aria-label="축소">−</button><button class="secondary compact" id="treeZoomReset" type="button">${Math.round(treeZoom * 100)}%</button><button class="secondary compact" id="treeZoomIn" type="button" aria-label="확대">＋</button></span><button class="secondary compact" id="treePrint" type="button">🖨 계보도 인쇄</button></div></div><p class="help">회원은 짧게 클릭하면 해당 회원 기준으로 바뀝니다. 빈 공간을 끌면 계보도가 이동합니다.</p><div class="family-tree pannable-tree"><div class="tree-stage" style="zoom:${treeZoom}"><ul>${displayRoots.map((root) => horizontalTreeNode(root)).join("")}</ul></div></div>`;
        if ($("treeAll"))
          $("treeAll").onclick = () => {
            focusedRoot = null;
            render();
          };
        if ($("treeUp"))
          $("treeUp").onclick = () => {
            focusedRoot = parent;
            detail(parent);
            render();
          };
        $("treePrint").onclick = () => {
          document.body.classList.add("printing-tree");
          window.print();
          setTimeout(
            () => document.body.classList.remove("printing-tree"),
            500,
          );
        };
        const setZoom = (value) => {
          treeZoom = Math.min(1.8, Math.max(0.5, value));
          const stage = document.querySelector(".tree-stage");
          if (stage) stage.style.zoom = treeZoom;
          $("treeZoomReset").textContent = `${Math.round(treeZoom * 100)}%`;
        };
        $("treeZoomOut").onclick = () => setZoom(treeZoom - 0.1);
        $("treeZoomIn").onclick = () => setZoom(treeZoom + 0.1);
        $("treeZoomReset").onclick = () => setZoom(1);
        bind();
        bindTreePan();
        return;
      }
      const filtered = rows.filter(
        (item) =>
          (depth === "all" || String(item.lv) === depth) &&
          (!query ||
            String(item.userName || "")
              .toLowerCase()
              .includes(query) ||
            String(item.userId || "").includes(query)),
      );
      $("orgView").innerHTML =
        `<div class="org-tree">${filtered.length ? filtered.map((item) => `<article class="org-member" style="--depth:${Math.min(Number(item.lv) || 0, 10)}"><div class="org-person"><span class="depth-badge">${Number(item.lv) || 0}</span><div><button class="member-name" data-member="${safe(item.userId)}" type="button">${safe(item.userName || "이름 없음")}</button><small>${safe(item.userId)} · ${safe(item.rankName || "회원")} / ${safe(item.rankMaxName || "회원")}</small></div></div><div class="org-nv"><span>본인 NV<b>${number(item.ordPv)}</b></span><span>대실적<b>${number(item.maxPv)}</b></span><span>소실적<b>${number(item.minPv)}</b></span></div></article>`).join("") : '<p class="help">검색 결과가 없습니다.</p>'}</div>`;
      bind();
    };
    const bindTreePan = () => {
      const canvas = document.querySelector(".pannable-tree");
      if (!canvas) return;
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
        if (Math.abs(dx) + Math.abs(dy) > 6 && !moved) {
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
    };
    $("orgSearch").oninput = render;
    $("depthFilter")
      .querySelectorAll("button")
      .forEach(
        (button) =>
          (button.onclick = () => {
            depth = button.dataset.depth;
            $("depthFilter")
              .querySelectorAll("button")
              .forEach((item) =>
                item.classList.toggle("active", item === button),
              );
            render();
          }),
      );
    document.querySelectorAll(".view-tabs button").forEach(
      (button) =>
        (button.onclick = () => {
          currentView = button.dataset.view;
          document
            .querySelectorAll(".view-tabs button")
            .forEach((item) =>
              item.classList.toggle("active", item === button),
            );
          $("depthFilter").hidden = true;
          $("orgSearch").value = "";
          depth = "all";
          $("depthFilter")
            .querySelectorAll("button")
            .forEach((item) =>
              item.classList.toggle("active", item.dataset.depth === "all"),
            );
          render();
        }),
    );
    detail(selected);
    render();
  } catch (err) {
    $("orgCollected").textContent = "조직 데이터를 불러오지 못했습니다.";
    $("orgError").textContent = friendlyError(err);
  }
}
const LOCAL_SYNC = "http://127.0.0.1:5050";
const CLOUD_SYNC = "https://nrc-sync-cloud-sg.onrender.com";
function setupAdminToggle() {
  const heading = $("accountHeading");
  const wrap = $("adminToggleWrap");
  const button = $("adminToggle");
  const status = $("adminToggleStatus");
  let clicks = 0;
  let clickTimer = null;
  heading.onclick = () => {
    clicks += 1;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => (clicks = 0), 2000);
    if (clicks >= 5) {
      clicks = 0;
      wrap.hidden = !wrap.hidden;
      if (!wrap.hidden) refreshAdminToggleLabel();
    }
  };
  async function refreshAdminToggleLabel() {
    const { data } = await supabase.rpc("is_app_admin").catch(() => ({ data: false }));
    button.textContent = data ? "관리자 모드 끄기" : "관리자 모드 켜기";
  }
  button.onclick = async () => {
    status.hidden = false;
    status.textContent = "처리 중...";
    try {
      const { data, error } = await supabase.rpc("toggle_self_admin");
      if (error) throw error;
      button.textContent = data ? "관리자 모드 끄기" : "관리자 모드 켜기";
      status.textContent = data ? "관리자 모드 켜짐" : "관리자 모드 꺼짐";
    } catch (err) {
      status.textContent = friendlyError(err);
    }
  };
}
async function settings(initialView = "profile") {
  $("content").innerHTML =
    `<div class="view-tabs settings-tabs"><button class="active" data-settings-view="profile" type="button">내 정보</button><button data-settings-view="connection" type="button">수집 PC</button><button data-settings-view="collection" type="button">수집</button><button data-settings-view="account" type="button">계정</button></div><section id="profileSettings" class="card"><div class="section-head"><div><h2>내 정보</h2><p class="help">이름을 바꾸면 화면 상단 인사말에도 바로 반영됩니다.</p></div></div><form id="profileForm"><div class="profile-form-grid"><label>이름<input id="profileName" required maxlength="40"></label><label>전화번호<input id="profilePhone" type="tel" inputmode="tel" placeholder="010-0000-0000"></label><label>이메일<input id="profileEmail" type="email" placeholder="name@example.com"></label><label>회원번호<input id="profileMemberNo" inputmode="numeric"></label><label>상호명<input id="profileBusiness" placeholder="예: 주하루"></label><label class="full">주소<input id="profileAddress"></label></div><button class="primary" id="saveProfile" type="submit">내 정보 저장</button><div id="profileStatus" class="connection-status" hidden></div><div id="profileError" class="error"></div></form></section><section id="connectionSettings" class="card" hidden><div class="section-head"><div><h2>수집 PC</h2><p class="help">여러 PC를 등록하면 켜져 있는 PC가 자동으로 수집 작업을 처리합니다. 연결 코드는 필요 없습니다.</p></div><a class="secondary" href="${LOCAL_SYNC}/setup" target="_blank" rel="noopener">이 PC 등록</a></div><div id="nrcStatus" class="connection-status">등록된 PC 확인 중...</div><div id="deviceList" class="schedule-list"></div><div id="nrcError" class="error"></div></section><section id="accountSettings" class="card" hidden><h2 id="accountHeading">앱 계정</h2><p class="help" id="profileUsername"></p><button class="secondary" id="logout">로그아웃</button><div id="adminToggleWrap" hidden><button class="secondary" id="adminToggle" type="button"></button><div id="adminToggleStatus" class="connection-status" hidden></div></div></section>`;
  const profile = await currentProfile();
  if (profile) {
    $("profileName").value = profile.name || "";
    $("profilePhone").value = profile.phone || "";
    $("profileEmail").value = profile.contact_email || "";
    $("profileMemberNo").value = profile.member_no || "";
    $("profileBusiness").value = profile.business_name || "";
    $("profileAddress").value = profile.address || "";
    $("profileUsername").textContent = profile.username
      ? `로그인 아이디: ${profile.username}`
      : "";
    if (profile.username === "wndudehsim") setupAdminToggle();
  }
  document.querySelectorAll("[data-settings-view]").forEach(
    (button) =>
      (button.onclick = () => {
        const view = button.dataset.settingsView;
        if (view === "collection") {
          collection();
          return;
        }
        document
          .querySelectorAll("[data-settings-view]")
          .forEach((item) => item.classList.toggle("active", item === button));
        $("profileSettings").hidden = view !== "profile";
        $("connectionSettings").hidden = view !== "connection";
        $("accountSettings").hidden = view !== "account";
        if (view === "connection") loadLocalStatus();
      }),
  );
  $("profileForm").onsubmit = async (event) => {
    event.preventDefault();
    const name = $("profileName").value.trim();
    $("profileError").textContent = "";
    $("profileStatus").hidden = true;
    if (name.length < 2) {
      $("profileError").textContent = "이름은 두 글자 이상 입력하세요.";
      return;
    }
    const value = {
        name,
        phone: $("profilePhone").value.trim() || null,
        contact_email: $("profileEmail").value.trim() || null,
        member_no: $("profileMemberNo").value.trim() || null,
        business_name: $("profileBusiness").value.trim() || null,
        address: $("profileAddress").value.trim() || null,
        updated_at: new Date().toISOString(),
      },
      { data, error } = await supabase
        .from("profiles")
        .update(value)
        .eq("id", me.id)
        .select(
          "id,username,member_no,name,phone,contact_email,business_name,address,status",
        )
        .single();
    if (error) {
      $("profileError").textContent =
        /column|schema cache|phone|contact_email|business_name/i.test(
          error.message,
        )
          ? "Supabase에서 RUN_009_PROFILE_INFO.sql을 먼저 실행하세요."
          : error.message;
      return;
    }
    me = data;
    $("userName").textContent = `${data.name}님`;
    $("profileStatus").hidden = false;
    $("profileStatus").textContent = "내 정보를 저장했습니다.";
  };
  $("logout").onclick = async () => {
    await supabase.auth.signOut({ scope: "local" });
    location.reload();
  };
  if (initialView !== "profile")
    document.querySelector(`[data-settings-view="${initialView}"]`)?.click();
}
async function collection() {
  $("content").innerHTML =
    `<div class="view-tabs settings-tabs"><button data-settings-jump="profile" type="button">내 정보</button><button data-settings-jump="connection" type="button">수집 PC</button><button class="active" type="button">수집</button><button data-settings-jump="account" type="button">계정</button></div><section class="card"><div class="section-head"><div><h2>공유 PC 수집 승인</h2><p class="help">NRC 로그인정보를 암호화해 보관하고, 승인된 온라인 Windows PC에 수집할 때만 전달합니다. 여러 계정을 등록하면 하위 사업자 매출도 함께 받아볼 수 있습니다.</p></div></div><div id="cloudCredentialList" class="schedule-list"></div><form id="cloudCredentialForm"><label>NRC 홈페이지 아이디<input id="cloudLoginId" autocomplete="username" required></label><label>NRC 홈페이지 비밀번호<input id="cloudPassword" type="password" autocomplete="current-password" required></label><button class="primary" id="cloudCredentialSave" type="submit">공유 PC 수집 승인·저장</button></form><div id="cloudCredentialStatus" class="connection-status">공유 수집 승인 상태 확인 중...</div><div id="cloudCredentialError" class="error"></div></section><section class="card"><h2>NRC 데이터 수집</h2><p class="help">승인된 PC 중 현재 켜져 있는 한 대가 계보·NV·소비자회선을 수집합니다. 모든 PC가 꺼져 있으면 요청은 대기합니다.</p><form id="collectForm"><label>수집할 NRC 계정<select id="nrcSourceAccount" required><option value="">승인 계정 확인 중...</option></select></label><button class="primary" id="nrcRun" type="submit">매출 데이터 받기</button></form><div id="nrcStatus" class="connection-status">수집 준비</div><div id="nrcError" class="error"></div></section><section class="card"><h2>공유 PC 자동수집 예약</h2><p class="help">매일 지정 시간에 켜져 있는 승인 PC 한 대가 자동 수집합니다.</p><form id="scheduleForm"><label>예약 이름<input id="scheduleLabel" placeholder="예: 주하루 오전 수집" required></label><label>NRC 계정<select id="scheduleSourceAccount" required><option value="">승인 계정 확인 중...</option></select></label><label>매일 실행 시간<input id="scheduleTime" type="time" required></label><button class="primary" type="submit">자동수집 예약 저장</button></form><div id="scheduleList" class="schedule-list"></div><div id="scheduleError" class="error"></div></section><section class="card"><h2>최근 수집 요청</h2><div id="jobList" class="schedule-list"><p class="help">요청 내역을 불러오는 중...</p></div></section>`;
  $("cloudCredentialForm").onsubmit = saveCloudCredential;
  $("collectForm").onsubmit = runCollection;
  $("scheduleForm").onsubmit = addSchedule;
  document
    .querySelectorAll("[data-settings-jump]")
    .forEach(
      (button) =>
        (button.onclick = () => settings(button.dataset.settingsJump)),
    );
  await loadCloudCredential();
  await Promise.all([loadSavedNrc(), loadSchedules(), loadRecentJobs()]);
}
async function localApi(path, options = {}) {
  const token = localStorage.getItem("nrc-sync-token") || "";
  const headers = { ...(options.headers || {}), "X-NRC-Sync-Token": token };
  let response;
  try {
    response = await fetch(`${LOCAL_SYNC}${path}`, {
      ...options,
      headers,
      targetAddressSpace: "local",
    });
  } catch (error) {
    const connectionError = new Error(
      "NRC Sync에 연결할 수 없습니다. Chrome의 로컬 네트워크 접근 권한을 허용한 뒤 새로고침해 주세요.",
    );
    connectionError.code = "LOCAL_SYNC_UNREACHABLE";
    throw connectionError;
  }
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const requestError = new Error(
      data.message || "로컬 동기화 프로그램 요청에 실패했습니다.",
    );
    requestError.status = response.status;
    throw requestError;
  }
  return data;
}
async function cloudApi(path, options = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw Error("앱 로그인 세션이 만료되었습니다. 다시 로그인해 주세요.");
  let response;
  try {
    response = await fetch(`${CLOUD_SYNC}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
        Authorization: `Bearer ${session.access_token}`,
      },
    });
  } catch {
    throw Error("클라우드 수집기를 깨우는 중입니다. 잠시 후 다시 눌러 주세요.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok)
    throw Error(data.message || "클라우드 수집기 요청에 실패했습니다.");
  return data;
}
async function loadCloudCredential() {
  const status = $("cloudCredentialStatus");
  if (!status) return null;
  const error = $("cloudCredentialError");
  error.textContent = "";
  try {
    const data = await cloudApi("/credentials");
    const accounts = data.credentials || [];
    const list = $("cloudCredentialList");
    if (list)
      list.innerHTML = accounts.length
        ? accounts
            .map(
              (item) =>
                `<article class="schedule-item"><div><b>NRC ${safe(item.source_account_id)}</b><small>승인일시: ${safe(new Date(item.updated_at).toLocaleString("ko-KR"))}</small></div><button class="secondary schedule-delete" data-account="${safe(item.source_account_id)}" type="button">승인 취소</button></article>`,
            )
            .join("")
        : "";
    list?.querySelectorAll(".schedule-delete").forEach(
      (button) => (button.onclick = () => deleteCloudCredential(button.dataset.account)),
    );
    status.textContent = accounts.length
      ? `공유 PC 수집 승인 계정 ${accounts.length}개`
      : "NRC 아이디와 비밀번호를 저장하면 공유 PC 수집이 승인됩니다.";
    return data;
  } catch (err) {
    status.textContent = "클라우드 수집기 상태를 확인하지 못했습니다.";
    error.textContent = friendlyError(err);
    return null;
  }
}
async function saveCloudCredential(event) {
  event.preventDefault();
  const button = $("cloudCredentialSave"),
    status = $("cloudCredentialStatus"),
    error = $("cloudCredentialError"),
    loginId = $("cloudLoginId").value.trim(),
    password = $("cloudPassword").value;
  error.textContent = "";
  button.disabled = true;
  button.textContent = "암호화하여 저장 중...";
  try {
    await cloudApi("/credentials", {
      method: "POST",
      body: JSON.stringify({ loginId, password }),
    });
    status.textContent = `공유 PC 수집 승인 완료 · NRC ${loginId}`;
    $("cloudLoginId").value = "";
    $("cloudPassword").value = "";
    await loadCloudCredential();
    await loadSavedNrc();
  } catch (err) {
    error.textContent = friendlyError(err);
  } finally {
    button.disabled = false;
    button.textContent = "공유 PC 수집 승인·저장";
  }
}
async function deleteCloudCredential(sourceAccountId) {
  if (!confirm(`NRC ${sourceAccountId} 계정의 공유 수집 승인을 취소할까요?`)) return;
  const error = $("cloudCredentialError");
  error.textContent = "";
  try {
    await cloudApi(`/credentials?sourceAccountId=${encodeURIComponent(sourceAccountId)}`, {
      method: "DELETE",
    });
    $("cloudCredentialStatus").textContent = "승인을 취소했습니다.";
    await loadCloudCredential();
    await loadSavedNrc();
  } catch (err) {
    error.textContent = friendlyError(err);
  }
}
async function loadSyncDevices() {
  const { data, error } = await supabase
    .from("nrc_sync_devices")
    .select("id,device_name,source_account_id,status,last_seen_at,last_error")
    .order("last_seen_at", { ascending: false });
  if (error) throw error;
  return data || [];
}
function isDeviceOnline(device) {
  const age = Date.now() - new Date(device.last_seen_at).getTime();
  return age < 45000 && ["ONLINE", "BUSY"].includes(device.status);
}
async function enqueueCollection(sourceAccountId = null) {
  const cloud = await cloudApi("/credentials").catch(() => null);
  const cloudAccounts = (cloud?.credentials || []).map(
    (item) => item.source_account_id,
  );
  const devices = await loadSyncDevices().catch(() => []);
  const online = devices.filter(
    (device) =>
      isDeviceOnline(device) &&
      (!sourceAccountId || device.source_account_id === sourceAccountId),
  );
  const selectedAccount = sourceAccountId || cloudAccounts[0] || online[0]?.source_account_id;
  const useCloud = Boolean(selectedAccount && cloudAccounts.includes(selectedAccount));
  if (!useCloud && !online.length)
    throw Error(
      sourceAccountId
        ? `${sourceAccountId} 계정의 공유 수집 승인을 먼저 저장해 주세요.`
        : "NRC 계정의 공유 PC 수집 승인을 먼저 저장해 주세요.",
    );
  const { data, error } = await supabase
    .from("nrc_sync_jobs")
    .insert({
      owner_id: me.id,
      source_account_id: selectedAccount,
      status: "QUEUED",
      message: useCloud
        ? "수집 가능한 승인 PC 배정 대기 중..."
        : "온라인 PC의 작업 수신 대기 중...",
    })
    .select("id,status,message")
    .single();
  if (error) throw error;
  if (useCloud) await cloudApi("/wake", { method: "POST" });
  return data;
}
async function waitForCollectionJob(jobId, onProgress) {
  for (let index = 0; index < 450; index++) {
    const { data, error } = await supabase
      .from("nrc_sync_jobs")
      .select("status,message,error")
      .eq("id", jobId)
      .single();
    if (error) throw error;
    onProgress?.(data.message || "수집 진행 중...");
    if (data.status === "SUCCESS") return data;
    if (["ERROR", "CANCELLED"].includes(data.status))
      throw Error(data.error || data.message || "수집에 실패했습니다.");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const pending = Error("수집 요청은 계속 대기 중이며 온라인 승인 PC가 자동으로 처리합니다.");
  pending.isPending = true;
  throw pending;
}
async function loadRecentJobs() {
  const list = $("jobList");
  if (!list) return;
  const { data, error } = await supabase
    .from("nrc_sync_jobs")
    .select("id,source_account_id,status,message,error,requested_at,completed_at")
    .order("requested_at", { ascending: false })
    .limit(2);
  if (error) {
    list.innerHTML = `<p class="error">${safe(friendlyError(error))}</p>`;
    return;
  }
  list.innerHTML = data.length
    ? data
        .map(
          (job) =>
            `<article class="schedule-item"><div><b>${safe(job.source_account_id || "NRC 수집")}</b><small>${safe(job.message || job.status)} · ${safe(new Date(job.requested_at).toLocaleString("ko-KR"))}</small>${job.error ? `<small class="error">${safe(job.error)}</small>` : ""}</div><span class="job-status ${safe(job.status.toLowerCase())}">${safe(job.status)}</span></article>`,
        )
        .join("")
    : '<p class="help">아직 수집 요청이 없습니다.</p>';
}
async function runHomeCollection() {
  const button = $("homeCollect"),
    status = $("homeCollectStatus"),
    errorBox = $("homeCollectError");
  errorBox.textContent = "";
  status.hidden = false;
  status.textContent = "매출 데이터 수집을 시작합니다...";
  button.disabled = true;
  button.textContent = "수집 중...";
  try {
    const job = await enqueueCollection();
    await waitForCollectionJob(job.id, (message) => {
      status.textContent = message;
    });
    status.textContent = "매출·계보·소비자회선 수집 완료";
    await home();
  } catch (error) {
    if (error.isPending) {
      status.textContent = friendlyError(error);
      errorBox.textContent = "";
    } else {
      errorBox.textContent = friendlyError(error);
    }
  } finally {
    button.disabled = false;
    button.textContent = "매출받기";
  }
}
let lastSharedDevicesError = "";
let lastSharedDevicesSummary = null;
async function loadSharedDevices() {
  lastSharedDevicesSummary = null;
  try {
    const data = await cloudApi("/devices");
    lastSharedDevicesError = "";
    if (data.summary) {
      lastSharedDevicesSummary = data.summary;
      return [];
    }
    return data.devices || [];
  } catch (err) {
    lastSharedDevicesError = friendlyError(err);
    console.warn("공유 PC 상태 조회 실패:", err);
    return loadSyncDevices();
  }
}
async function loadHomePcStatus() {
  const box = $("homePcStatus");
  if (!box) return;
  try {
    const devices = await loadSharedDevices();
    if (lastSharedDevicesSummary) {
      const { total, online } = lastSharedDevicesSummary;
      box.innerHTML = online
        ? `<span class="device-dot online"></span><span>공유 수집 PC 온라인 ${online}대 · 지금 수집 가능</span>`
        : total
          ? `<span class="device-dot offline"></span><span>공유 수집 PC가 모두 오프라인입니다 · 요청은 대기 후 처리됩니다</span>`
          : `<span class="device-dot offline"></span><span>등록된 수집 PC가 없습니다</span>`;
      return;
    }
    const online = devices.filter(isDeviceOnline);
    box.innerHTML = online.length
      ? `<span class="device-dot online"></span><span>공유 수집 PC 온라인 ${online.length}대 · 지금 수집 가능</span>`
      : devices.length
        ? `<span class="device-dot offline"></span><span>공유 수집 PC가 모두 오프라인입니다 · 요청은 대기 후 처리됩니다</span>`
        : `<span class="device-dot offline"></span><span>등록된 수집 PC가 없습니다</span>`;
  } catch {
    box.innerHTML = `<span class="device-dot offline"></span><span>수집 PC 상태를 확인하지 못했습니다</span>`;
  }
}
async function loadLocalStatus() {
  const box = $("nrcStatus");
  if (!box) return;
  try {
    const devices = await loadSharedDevices();
    const list = $("deviceList");
    const nrcErrorBox = $("nrcError");
    if (lastSharedDevicesSummary) {
      const { total, online } = lastSharedDevicesSummary;
      box.textContent = total
        ? `공유 수집 PC ${total}대 · 현재 온라인 ${online}대`
        : "등록된 수집 PC가 없습니다. ‘이 PC 등록’을 눌러 최초 설정해 주세요.";
      if (list) list.innerHTML = "";
      nrcErrorBox.classList.remove("error");
      nrcErrorBox.textContent = "";
      return;
    }
    const online = devices.filter(isDeviceOnline);
    box.textContent = devices.length
      ? `공유 수집 PC ${devices.length}대 · 현재 온라인 ${online.length}대`
      : "등록된 수집 PC가 없습니다. ‘이 PC 등록’을 눌러 최초 설정해 주세요.";
    if (list)
      list.innerHTML = devices.length
        ? devices
            .map(
              (device) =>
                `<article class="schedule-item"><div><b>${safe(device.device_name)}</b><small>${isDeviceOnline(device) ? "온라인 · 수집 가능" : "오프라인"}</small><small>최근 확인: ${safe(new Date(device.last_seen_at).toLocaleString("ko-KR"))}</small></div><span class="device-dot ${isDeviceOnline(device) ? "online" : "offline"}"></span></article>`,
            )
            .join("")
        : "";
    nrcErrorBox.classList.add("error");
    nrcErrorBox.textContent = lastSharedDevicesError
      ? `(진단) 공유 PC 상태 조회 실패: ${lastSharedDevicesError}`
      : "";
  } catch (err) {
    box.textContent = "수집 PC 정보를 불러오지 못했습니다.";
    $("nrcError").textContent = /nrc_sync_devices|schema cache/i.test(err.message)
      ? "Supabase에서 RUN_013_MULTI_PC_SYNC_QUEUE.sql을 먼저 실행해 주세요."
      : friendlyError(err);
  }
}
async function runCollection(e) {
  e.preventDefault();
  const button = $("nrcRun"),
    error = $("nrcError"),
    loginId = $("nrcSourceAccount").value;
  error.textContent = "";
  $("nrcStatus").textContent = "수집 가능한 승인 PC를 찾는 중...";
  button.disabled = true;
  button.textContent = "승인 PC 수집 중...";
  try {
    const job = await enqueueCollection(loginId);
    await waitForCollectionJob(job.id, (message) => {
      $("nrcStatus").textContent = message;
    });
    $("nrcStatus").textContent = "계보·NV·소비자회선 수집 완료";
    await loadRecentJobs();
  } catch (err) {
    if (err.isPending) {
      $("nrcStatus").textContent = friendlyError(err);
      error.textContent = "";
      await loadRecentJobs();
    } else {
      error.textContent = friendlyError(err);
    }
  } finally {
    button.disabled = false;
    button.textContent = "매출 데이터 받기";
  }
}
async function loadSavedNrc() {
  try {
    let [cloud, devices] = await Promise.all([
      cloudApi("/credentials").catch(() => null),
      loadSyncDevices().catch(() => []),
    ]);
    if (!cloud) {
      // 클라우드 수집기가 잠들어 있다가 방금 깨어난 경우를 대비해 한 번 더 시도
      await new Promise((resolve) => setTimeout(resolve, 3000));
      cloud = await cloudApi("/credentials").catch(() => null);
    }
    const select = $("nrcSourceAccount");
    if (!select) return;
    const accounts = [
      ...new Set([
        ...(cloud?.credentials || []).map((item) => item.source_account_id),
        ...devices.map((item) => item.source_account_id),
      ]),
    ];
    select.innerHTML = accounts.length
      ? accounts.map((account) => `<option value="${safe(account)}">${safe(account)}</option>`).join("")
      : '<option value="">등록된 NRC 계정 없음</option>';
    $("nrcRun").disabled = !accounts.length;
    const scheduleSelect = $("scheduleSourceAccount");
    if (scheduleSelect)
      scheduleSelect.innerHTML = accounts.length
        ? accounts.map((account) => `<option value="${safe(account)}">${safe(account)}</option>`).join("")
        : '<option value="">등록된 NRC 계정 없음</option>';
  } catch (err) {
    $("nrcError").textContent = friendlyError(err);
  }
}
const safe = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
async function loadSchedules() {
  const list = $("scheduleList");
  if (!list) return;
  try {
    const { data, error } = await supabase
      .from("nrc_sync_schedules")
      .select("id,label,source_account_id,run_time,enabled,last_enqueued_on")
      .order("run_time");
    if (error) throw error;
    list.innerHTML = data.length
      ? data
          .map(
            (item) =>
              `<article class="schedule-item"><div><b>${safe(item.label)}</b><small>${safe(item.source_account_id)} · 매일 ${safe(String(item.run_time).slice(0,5))}</small><small>${item.last_enqueued_on ? `최근 요청: ${safe(item.last_enqueued_on)}` : "아직 실행 전"}</small></div><button class="secondary schedule-delete" data-id="${safe(item.id)}" type="button">삭제</button></article>`,
          )
          .join("")
      : '<p class="help">등록된 자동수집 예약이 없습니다.</p>';
    list
      .querySelectorAll(".schedule-delete")
      .forEach(
        (button) => (button.onclick = () => deleteSchedule(button.dataset.id)),
      );
  } catch (err) {
    list.innerHTML = "";
    $("scheduleError").textContent = friendlyError(err);
  }
}
async function addSchedule(e) {
  e.preventDefault();
  const error = $("scheduleError");
  error.textContent = "";
  try {
    const { error: saveError } = await supabase
      .from("nrc_sync_schedules")
      .insert({
        owner_id: me.id,
        label: $("scheduleLabel").value.trim(),
        source_account_id: $("scheduleSourceAccount").value,
        run_time: $("scheduleTime").value,
        timezone: "Asia/Seoul",
      });
    if (saveError) throw saveError;
    e.target.reset();
    await loadSchedules();
  } catch (err) {
    error.textContent = friendlyError(err);
  }
}
async function deleteSchedule(scheduleId) {
  if (!confirm("이 자동수집 예약을 삭제할까요?")) return;
  try {
    const { error } = await supabase
      .from("nrc_sync_schedules")
      .delete()
      .eq("id", scheduleId);
    if (error) throw error;
    await loadSchedules();
  } catch (err) {
    $("scheduleError").textContent = friendlyError(err);
  }
}
function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  $("authDescription").textContent = signup
    ? "아이디와 비밀번호만 정하면 가입됩니다."
    : "아이디와 비밀번호로 로그인하세요.";
  $("authSubmit").textContent = signup ? "회원가입" : "로그인";
  $("authModeBtn").textContent = signup
    ? "이미 계정이 있나요? 로그인"
    : "처음이신가요? 회원가입";
  $("loginPassword").autocomplete = signup
    ? "new-password"
    : "current-password";
  document.querySelectorAll(".signup-only").forEach((label) => {
    label.hidden = !signup;
    label.querySelector("input").required = signup;
  });
}
async function start() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw Error("로그인 세션을 만들지 못했습니다.");
  const username = session.user.user_metadata?.username || "사용자";
  const profile = await currentProfile().catch(() => null);
  me = profile || { id: session.user.id, name: username, status: "ACTIVE" };
  setTelemetryUser(me.id);
  appAdmin = await isAppAdmin();
  if (!trackingInstalled) {
    installInteractionTracking();
    trackingInstalled = true;
  }
  $("loginView").hidden = true;
  $("appView").hidden = false;
  $("userName").textContent = `${me.name || username}님`;
  nav();
  show("home");
}
$("authModeBtn").onclick = () =>
  setAuthMode(authMode === "login" ? "signup" : "login");
$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const errorBox = $("loginError"),
    submit = $("authSubmit"),
    username = $("loginUsername").value.trim(),
    password = $("loginPassword").value;
  errorBox.textContent = "";
  submit.disabled = true;
  submit.textContent = authMode === "signup" ? "가입 중..." : "로그인 중...";
  setRememberLogin($("rememberLogin").checked);
  try {
    if (authMode === "signup") {
      try {
        const result = await signUp({
          username,
          password,
          name: $("signupName").value,
          memberNo: $("signupMemberNo").value,
        });
        if (!result.session) await signIn({ username, password });
      } catch (err) {
        if (/already registered/i.test(err.cause?.message || err.message))
          await signIn({ username, password });
        else throw err;
      }
    } else await signIn({ username, password });
    await start();
  } catch (err) {
    errorBox.textContent = friendlyError(err, "로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  } finally {
    submit.disabled = false;
    submit.textContent = authMode === "signup" ? "회원가입" : "로그인";
  }
};
$("refreshBtn").onclick = () => show("home");
if (!supabase) {
  $("loginError").textContent = "Supabase publishable key 설정이 필요합니다.";
} else {
  supabase.auth.getSession().then(({ data }) => {
    if (data.session) start().catch(() => {});
  });
}
