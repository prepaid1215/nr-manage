import { supabase } from "./supabase.js?v=20260829-34";
import { friendlyError } from "./errors.js?v=20260830-1";

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
const eventNames = { page_view: "화면 방문", action: "버튼 사용", submit: "저장/실행" };

export async function isAppAdmin() {
  const { data, error } = await supabase.rpc("is_app_admin");
  if (error) return false;
  return Boolean(data);
}

export async function adminPage(root) {
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>관리자 사용현황</h2><p class="help">가입자별 접속·수집·마감 사용 현황입니다. 비밀번호와 입력 내용은 기록하지 않습니다.</p></div><button id="adminReload" class="secondary compact" type="button">새로고침</button></div><div id="adminSummary" class="admin-summary"></div><label>사용자 검색<input id="adminSearch" type="search" placeholder="이름, 앱 아이디, 회원번호"></label><div id="adminError" class="error"></div></section><section class="card"><h2>가입자 현황</h2><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>사용자</th><th>최근 활동</th><th>최근 화면</th><th>수집</th><th>마감 계획</th></tr></thead><tbody id="adminUsers"></tbody></table></div></section><section class="card"><h2>최근 행동</h2><div id="adminEvents" class="admin-events"></div></section>`;
  const $ = (id) => document.getElementById(id);
  let users = [];
  const renderUsers = () => {
    const query = $("adminSearch").value.trim().toLowerCase();
    const filtered = users.filter((row) =>
      [row.name, row.username, row.member_no].some((value) => String(value || "").toLowerCase().includes(query)),
    );
    $("adminUsers").innerHTML = filtered.length
      ? filtered.map((row) => `<tr><td><b>${safe(row.name || "이름 없음")}</b><small>${safe(row.username || "-")} · ${safe(row.member_no || "회원번호 없음")}</small></td><td>${safe(date(row.last_seen_at))}<small>기록 ${Number(row.event_count || 0).toLocaleString()}건</small></td><td>${safe(pageNames[row.last_page] || row.last_page || "-")}</td><td>${safe(date(row.last_snapshot_at))}</td><td>진행 ${Number(row.draft_plan_count || 0)} · 완료 ${Number(row.done_plan_count || 0)}</td></tr>`).join("")
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
    $("adminSummary").innerHTML = `<article><span>전체 가입자</span><b>${users.length}명</b></article><article><span>오늘 활동</span><b>${activeToday}명</b></article><article><span>최근 오류</span><b>${errorsToday}건</b></article>`;
    renderUsers();
    $("adminEvents").innerHTML = events.length
      ? events.map((row) => `<article><time>${safe(date(row.created_at))}</time><b>${safe(row.user_name || row.username || "사용자")}</b><span>${safe(eventNames[row.event_type] || row.event_type)} · ${safe(pageNames[row.page] || row.page || "-")}${row.action ? ` · ${safe(row.action)}` : ""}</span></article>`).join("")
      : '<p class="help">아직 기록된 행동이 없습니다.</p>';
  };
  $("adminSearch").oninput = renderUsers;
  $("adminReload").onclick = load;
  await load();
}
