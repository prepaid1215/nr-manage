import {
  supabase,
  signUp,
  signIn,
  currentProfile,
} from "./supabase.js?v=20260829-32";
import { customersPage } from "./customers.js?v=20260829-21";
import { activityPage } from "./activity.js?v=20260829-25";
import {
  checklistItemCount,
  checklistPage,
} from "./checklist.js?v=20260829-29";
import { closingPage, commissionPage } from "./finance.js?v=20260829-28";
import { performancePage } from "./performance.js?v=20260829-26";
import { teamPage } from "./team.js?v=20260829-35";
import { localDate, monthRange } from "./date.js?v=20260829-25";
const $ = (id) => document.getElementById(id);
let me = null,
  authMode = "login";
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
];
function nav() {
  const html = menus
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
async function home() {
  const frag = $("homeTemplate").content.cloneNode(true);
  $("content").replaceChildren(frag);
  $("content").insertAdjacentHTML(
    "afterbegin",
    `<section class="card home-nrc"><div class="section-head"><div><h2>NRC 매출 대시보드</h2><p class="help" id="homeNrcUpdated">최근 수집 데이터를 불러오는 중...</p></div><button class="primary compact" id="homeCollect" type="button">매출받기</button></div><div id="homeNrcDashboard"><p class="help">수집된 매출 데이터가 없습니다.</p></div></section>`,
  );
  $("content").insertAdjacentHTML(
    "beforeend",
    `<section class="card"><h2>알림</h2><div id="homeAlerts" class="home-alerts"><p class="help">알림을 불러오는 중...</p></div></section>`,
  );
  $("homeCollect").onclick = () => settings("collection");
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
      `<article>⚠️ 데이터를 불러오지 못했습니다: ${safe(failed.message)}</article>`;
    return;
  }
  const cs = customers.data || [],
    acts = activity.data || [],
    todayAct = acts.find((r) => r.activity_date === today),
    monthActivation = cs.filter((c) =>
      c.activation_date?.startsWith(month),
    ).length,
    newMoney = acts.reduce((s, r) => s + Number(r.new_transfer || 0), 0),
    repurchase = acts.reduce((s, r) => s + Number(r.repurchase || 0), 0),
    balance = acts.at(-1)?.balance || 0;
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
    $("homeNrcUpdated").textContent =
      `최종 업데이트 ${new Date(snapshot.data.collected_at).toLocaleString("ko-KR")}`;
    $("homeNrcDashboard").innerHTML =
      `<div class="nrc-overview"><article><h3>본인 매출 현황</h3><div><span>본인매출 NV<b>${number(own)}</b></span><span>대실적<b>${number(major)}</b></span><span>소실적<b>${number(minor)}</b></span></div></article><article><h3>직급 현황</h3><div><span>현재직급<b>${safe(rank)}</b></span><span>인증직급<b>${safe(certified)}</b></span></div></article><article><h3>조직 현황</h3><div><span>전체 회원<b>${treeRows.length.toLocaleString()}명</b></span><span>활동 회원<b>${treeRows.filter((item) => String(item.status) === "1" && !item.dormant).length.toLocaleString()}명</b></span></div></article></div><div class="nrc-gauges"><article><div class="nrc-gauge major"><span>대실적<b>${number(major)}</b></span></div></article><article><div class="nrc-gauge minor"><span>소실적<b>${number(minor)}</b></span></div></article></div>`;
  }
  $("todayActivations").textContent =
    `${cs.filter((c) => c.activation_date === today).length}건`;
  $("newTransfer").textContent = `${newMoney.toLocaleString()}원`;
  $("repurchase").textContent = `${repurchase.toLocaleString()}원`;
  $("balance").textContent = `${Number(balance).toLocaleString()}원`;
  $("attendance").textContent =
    `${acts.reduce((s, r) => s + Number(r.attendance || 0), 0)}명`;
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
async function show(page) {
  document
    .querySelectorAll("[data-page]")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  if (page === "home") return home();
  if (page === "customers") return customersPage($("content"), me);
  if (page === "activity") return activityPage($("content"), me);
  if (page === "checklist") return checklistPage($("content"), me);
  if (page === "organization") return organizationDashboard();
  if (page === "performance") return performancePage($("content"), me);
  if (page === "commission") return commissionPage($("content"), me);
  if (page === "closing") return closingPage($("content"), me);
  if (page === "team") return teamPage($("content"), me);
  if (page === "settings") return settings();
  $("content").innerHTML =
    `<section class="card"><h2>${menus.find((x) => x[0] === page)?.[1] || "더보기"}</h2><p>기획서 기준 모듈을 순서대로 연결 중입니다.</p></section>`;
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
    $("orgError").textContent = err.message;
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
    $("orgError").textContent = err.message;
  }
}
async function organizationDashboard() {
  $("content").innerHTML =
    `<section class="card"><div class="section-head"><div><h2>조직 현황</h2><p class="help" id="orgCollected">최신 데이터를 불러오는 중...</p></div><button class="secondary compact" id="orgReload" type="button">새로고침</button></div><div class="view-tabs"><button class="active" data-view="list" type="button">하위 매출 현황</button><button data-view="tree" type="button">계보도</button></div><div class="org-summary" id="orgSummary"></div><label>회원 검색<input id="orgSearch" type="search" placeholder="이름 또는 회원번호"></label><div class="depth-filter" id="depthFilter" hidden></div><div id="orgError" class="error"></div><section class="card member-sales-card member-sales-inline"><h2>선택 회원 매출 현황</h2><div id="memberDetailInline"><p class="help">회원 이름을 선택하세요.</p></div></section><div id="orgView"></div></section>`;
  $("orgReload").onclick = organizationDashboard;
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
      focusedRoot = null;
    $("orgCollected").textContent =
      `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · NRC ${data.source_account_id || "-"}`;
    $("orgSummary").innerHTML =
      `<article><span>전체 회원</span><b>${rows.length.toLocaleString()}명</b></article><article><span>최대 단계</span><b>${maxDepth}단계</b></article><article><span>활동 회원</span><b>${rows.filter((item) => String(item.status) === "1" && !item.dormant).length.toLocaleString()}명</b></article>`;
    $("depthFilter").innerHTML =
      `<button class="active" data-depth="all">전체</button>${Array.from({ length: maxDepth + 1 }, (_, value) => `<button data-depth="${value}">${value}단계</button>`).join("")}`;
    const detail = (item) => {
      if (!item) return;
      selected = item;
      const parent = byId.get(String(item.ppId || ""));
      $("memberDetailInline").innerHTML =
        `<table class="detail-table inline"><tbody><tr><th>성명</th><td>${safe(item.userName || "—")}</td><th>회원번호</th><td>${safe(item.userId || "—")}</td></tr><tr><th>현재직급</th><td>${safe(item.rankName || "회원")}</td><th>인증직급</th><td>${safe(item.rankMaxName || "회원")}</td></tr><tr><th>본인매출 NV</th><td>${number(item.ordPv)}</td><th>정산 적용 NV</th><td>${number(item.ordPv)}</td></tr><tr><th>대실적(실시간)</th><td>${number(item.maxPv)}</td><th>소실적(실시간)</th><td>${number(item.minPv)}</td></tr><tr><th>상위회원</th><td>${parent ? safe(parent.userName) : "—"}</td><th>계보 단계</th><td>${Number(item.lv) || 0}단계</td></tr><tr><th>활동 상태</th><td>${item.dormant ? "휴면" : String(item.status) === "1" ? "활동" : "비활동"}</td><th>가입일</th><td>${safe(item.regDate || "—")}</td></tr></tbody></table><p class="detail-note">※ 현재 수집 JSON에 존재하는 값만 표시합니다.</p>`;
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
    const treeNode = (item, path = new Set(), relation = "본") => {
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
      const content = `<span class="sales-summary"><b>${safe(item.userName || "이름 없음")} <small>(${safe(item.userId || "코드 없음")})</small></b><em>${safe(relation)}</em><span>대실적 : <strong>${number(item.maxPv)}</strong></span><span>소실적 : <strong>${number(item.minPv)}</strong></span></span>`;
      if (!descendants.length) {
        return `<li><button class="family-node family-leaf" data-member="${safe(item.userId)}" type="button">${content}</button></li>`;
      }
      return `<li><details class="family-branch"><summary class="family-node" data-member="${safe(item.userId)}">${content}</summary><ul>${descendants.map((child, index) => treeNode(child, next, `서브${index + 1}`)).join("")}</ul></details></li>`;
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
          `<div class="tree-focus-bar"><span>기준: <b>${safe(focusedRoot?.userName || "전체 계보도")}</b></span><div>${focusedRoot ? '<button class="secondary compact" id="treeAll" type="button">전체 계보도</button>' : ""}${parent ? '<button class="secondary compact" id="treeUp" type="button">상위 회원으로</button>' : ""}<button class="secondary compact" id="treePrint" type="button">🖨 계보도 인쇄</button></div></div><p class="help">회원을 클릭하면 해당 회원을 기준으로 다시 표시합니다. 계보도의 빈 공간을 손바닥으로 잡아 이동할 수 있습니다.</p><div class="family-tree pannable-tree"><ul>${displayRoots.map((root) => horizontalTreeNode(root)).join("")}</ul></div>`;
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
        canvas.classList.add("dragging");
        canvas.setPointerCapture(event.pointerId);
      };
      canvas.onpointermove = (event) => {
        if (!active) return;
        const dx = event.clientX - startX,
          dy = event.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
        canvas.scrollLeft = scrollLeft - dx;
        canvas.scrollTop = scrollTop - dy;
      };
      const stop = () => {
        active = false;
        canvas.classList.remove("dragging");
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
    $("orgError").textContent = err.message;
  }
}
const LOCAL_SYNC = "http://127.0.0.1:5050";
async function settings(initialView = "profile") {
  $("content").innerHTML =
    `<div class="view-tabs settings-tabs"><button class="active" data-settings-view="profile" type="button">내 정보</button><button data-settings-view="connection" type="button">PC 연결</button><button data-settings-view="collection" type="button">수집</button><button data-settings-view="account" type="button">계정</button></div><section id="profileSettings" class="card"><div class="section-head"><div><h2>내 정보</h2><p class="help">이름을 바꾸면 화면 상단 인사말에도 바로 반영됩니다.</p></div></div><form id="profileForm"><div class="profile-form-grid"><label>이름<input id="profileName" required maxlength="40"></label><label>전화번호<input id="profilePhone" type="tel" inputmode="tel" placeholder="010-0000-0000"></label><label>이메일<input id="profileEmail" type="email" placeholder="name@example.com"></label><label>회원번호<input id="profileMemberNo" inputmode="numeric"></label><label>상호명<input id="profileBusiness" placeholder="예: 주하루"></label><label class="full">주소<input id="profileAddress"></label></div><button class="primary" id="saveProfile" type="submit">내 정보 저장</button><div id="profileStatus" class="connection-status" hidden></div><div id="profileError" class="error"></div></form></section><section id="connectionSettings" class="card" hidden><h2>내 컴퓨터 연결</h2><p class="help">최초 한 번만 이 PC의 NRC Sync 연결 코드를 저장하세요.</p><label>내 컴퓨터 연결 코드<input id="syncToken" type="password" autocomplete="off" placeholder="NRC Sync 연결 코드"></label><button class="primary" id="saveSyncToken" type="button">연결 코드 저장</button><div id="nrcStatus" class="connection-status">내 컴퓨터 연결 확인 중...</div><div id="nrcError" class="error"></div></section><section id="accountSettings" class="card" hidden><h2>앱 계정</h2><p class="help" id="profileUsername"></p><button class="secondary" id="logout">로그아웃</button></section>`;
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
  $("syncToken").value = localStorage.getItem("nrc-sync-token") || "";
  $("saveSyncToken").onclick = () => {
    localStorage.setItem("nrc-sync-token", $("syncToken").value.trim());
    loadLocalStatus();
  };
  if (initialView !== "profile")
    document.querySelector(`[data-settings-view="${initialView}"]`)?.click();
}
async function collection() {
  $("content").innerHTML =
    `<div class="view-tabs settings-tabs"><button data-settings-jump="profile" type="button">내 정보</button><button data-settings-jump="connection" type="button">PC 연결</button><button class="active" type="button">수집</button><button data-settings-jump="account" type="button">계정</button></div><section class="card"><h2>NRC 홈페이지 JSON 수집</h2><p class="help">저장을 선택하면 NRC 로그인 정보는 이 PC의 Windows 자격 증명 저장소에만 보관됩니다.</p><form id="collectForm"><label>NRC 홈페이지 아이디<input id="nrcLoginId" autocomplete="username" required></label><label>NRC 홈페이지 비밀번호<input id="nrcPassword" type="password" autocomplete="current-password" placeholder="저장된 경우 비워도 됩니다"></label><label class="check"><input id="rememberNrc" type="checkbox"> NRC 아이디·비밀번호 이 PC에 저장</label><button class="primary" id="nrcRun" type="submit">매출 데이터 받기</button></form><button class="secondary" id="clearNrcCredentials" type="button" hidden>저장된 NRC 로그인 정보 삭제</button><div id="nrcStatus" class="connection-status">수집 준비</div><div id="nrcError" class="error"></div></section><section class="card"><h2>PC 자동수집 예약</h2><p class="help">PC가 켜져 있고 NRC Sync가 실행 중이면 매일 지정 시간에 자동 수집하고 Supabase에 저장합니다.</p><form id="scheduleForm"><label>예약 이름<input id="scheduleLabel" placeholder="예: 임영은 오전 수집" required></label><label>NRC 홈페이지 아이디<input id="scheduleLoginId" autocomplete="username" required></label><label>NRC 홈페이지 비밀번호<input id="schedulePassword" type="password" autocomplete="current-password" required></label><label>매일 실행 시간<input id="scheduleTime" type="time" required></label><button class="primary" type="submit">자동수집 예약 저장</button></form><div id="scheduleList" class="schedule-list"></div><div id="scheduleError" class="error"></div></section>`;
  $("collectForm").onsubmit = runCollection;
  $("clearNrcCredentials").onclick = clearSavedNrc;
  $("scheduleForm").onsubmit = addSchedule;
  document
    .querySelectorAll("[data-settings-jump]")
    .forEach(
      (button) =>
        (button.onclick = () => settings(button.dataset.settingsJump)),
    );
  await Promise.all([loadLocalStatus(), loadSavedNrc(), loadSchedules()]);
}
async function localApi(path, options = {}) {
  const token = localStorage.getItem("nrc-sync-token") || "";
  const headers = { ...(options.headers || {}), "X-NRC-Sync-Token": token };
  const response = await fetch(`${LOCAL_SYNC}${path}`, { ...options, headers });
  const data = await response.json();
  if (!response.ok || !data.ok)
    throw Error(data.message || "로컬 동기화 프로그램 요청에 실패했습니다.");
  return data;
}
async function loadLocalStatus() {
  const box = $("nrcStatus");
  if (!box) return;
  try {
    const result = await localApi("/api/status");
    box.textContent = result.sync?.running
      ? "NRC 데이터 수집 중..."
      : "내 컴퓨터 NRC Sync 연결됨";
    $("nrcError").textContent = "";
  } catch (err) {
    box.textContent = "NRC Sync가 꺼져 있거나 연결 코드가 다릅니다.";
    $("nrcError").textContent = err.message;
  }
}
async function runCollection(e) {
  e.preventDefault();
  const button = $("nrcRun"),
    error = $("nrcError"),
    loginId = $("nrcLoginId").value.trim(),
    password = $("nrcPassword").value;
  error.textContent = "";
  button.disabled = true;
  button.textContent = "Playwright 수집 중...";
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    await localApi("/api/sync/combined", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loginId,
        password,
        remember: $("rememberNrc").checked,
        appUserId: user.id,
      }),
    });
    $("nrcPassword").value = "";
    let result = null;
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const status = await localApi("/api/status");
      $("nrcStatus").textContent =
        status.sync?.message || "NRC 데이터 수집 중...";
      if (status.sync?.error) throw Error(status.sync.error);
      if (
        status.sync?.completed &&
        status.sync?.source_account_id === loginId
      ) {
        result = await localApi("/api/combined");
        break;
      }
    }
    if (!result)
      throw Error("수집 시간이 오래 걸립니다. 잠시 후 다시 확인하세요.");
    const { error: saveError } = await supabase
      .from("nrc_sync_snapshots")
      .insert({
        owner_id: user.id,
        source_account_id: loginId,
        snapshot_type: "combined",
        payload: result.data,
        collected_at: result.collected_at || new Date().toISOString(),
      });
    if (saveError) throw saveError;
    $("nrcStatus").textContent = "10단계 JSON 수집 및 Supabase 저장 완료";
    await loadSavedNrc();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = "매출 데이터 받기";
  }
}
async function loadSavedNrc() {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const result = await localApi(
      `/api/manual-credentials?appUserId=${encodeURIComponent(user.id)}`,
    );
    if (result.saved) {
      $("nrcLoginId").value = result.loginId;
      $("rememberNrc").checked = true;
      $("clearNrcCredentials").hidden = false;
    }
  } catch {}
}
async function clearSavedNrc() {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    await localApi("/api/manual-credentials", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appUserId: user.id }),
    });
    $("rememberNrc").checked = false;
    $("nrcPassword").value = "";
    $("clearNrcCredentials").hidden = true;
    $("nrcStatus").textContent = "저장된 NRC 로그인 정보를 삭제했습니다.";
  } catch (err) {
    $("nrcError").textContent = err.message;
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
    const result = await localApi("/api/schedules");
    list.innerHTML = result.schedules.length
      ? result.schedules
          .map(
            (item) =>
              `<article class="schedule-item"><div><b>${safe(item.label)}</b><small>${safe(item.login_id_masked)} · 매일 ${safe(item.time)}</small><small>최근 결과: ${safe(item.last_status || "WAITING")}${item.last_run ? ` · ${safe(item.last_run)}` : ""}</small></div><button class="secondary schedule-delete" data-id="${safe(item.id)}" type="button">삭제</button></article>`,
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
    $("scheduleError").textContent = err.message;
  }
}
async function addSchedule(e) {
  e.preventDefault();
  const error = $("scheduleError");
  error.textContent = "";
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) throw Error("앱 로그인이 필요합니다.");
    await localApi("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: $("scheduleLabel").value.trim(),
        loginId: $("scheduleLoginId").value.trim(),
        password: $("schedulePassword").value,
        time: $("scheduleTime").value,
        userId: session.user.id,
        refreshToken: session.refresh_token,
      }),
    });
    e.target.reset();
    await loadSchedules();
  } catch (err) {
    error.textContent = err.message;
  }
}
async function deleteSchedule(scheduleId) {
  if (!confirm("이 자동수집 예약을 삭제할까요?")) return;
  try {
    await localApi("/api/schedules", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduleId }),
    });
    await loadSchedules();
  } catch (err) {
    $("scheduleError").textContent = err.message;
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
        if (/already registered/i.test(err.message))
          await signIn({ username, password });
        else throw err;
      }
    } else await signIn({ username, password });
    await start();
  } catch (err) {
    errorBox.textContent = /invalid login credentials/i.test(err.message)
      ? "아이디 또는 비밀번호가 맞지 않습니다."
      : /email not confirmed/i.test(err.message)
        ? "관리자 설정에서 이메일 확인을 꺼주세요."
        : err.message;
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
