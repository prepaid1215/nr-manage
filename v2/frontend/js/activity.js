import { supabase } from "./supabase.js?v=20260829-11";
import { localDate, monthRange } from "./date.js?v=20260829-25";
const postingFields = [
  ["blog_sloom", "슬룸"],
  ["blog_modoo", "모두"],
  ["blog_main", "메인"],
  ["cafe", "카페"],
  ["wordpress", "워드프레스"],
  ["threads", "스레드"],
  ["instagram", "인스타"],
  ["youtube", "유튜브"],
  ["carrot", "당근"],
  ["openchat", "오픈채팅"],
  ["qa", "질의응답"],
  ["knowledge", "지식인"],
  ["meeting", "미팅"],
];
const today = localDate;
export async function activityPage(root, me) {
  root.innerHTML = `<section class="card"><h2>일일업무일지</h2><label>기록할 날짜<input id="activityDate" type="date" value="${today()}"></label></section><section class="activity-hero"><span>오늘 개통</span><b id="activationTotal">0건</b></section><form id="activityForm"><section class="card"><div class="section-head"><h2>포스팅 / SNS 기록</h2><b id="postingTotal">총 0건</b></div><div class="activity-grid">${postingFields.map(([key, label]) => `<label>${label}<input type="number" min="0" value="0" data-posting="${key}"></label>`).join("")}</div></section><section class="card"><h2>개통·매출 기록</h2><div class="activity-grid two"><label>신규개통양도금(원)<input id="newTransfer" type="number" min="0" value="0"></label><label>재구매요금양도금(원)<input id="repurchase" type="number" min="0" value="0"></label><label>현재요금잔액(원)<input id="balance" type="number" min="0" value="0"></label><label>앤보임 수강생<input id="attendance" type="number" min="0" value="0"></label><label>A 자동매출(NV)<input id="aSales" type="number" min="0" value="0"></label><label>B 자동매출(NV)<input id="bSales" type="number" min="0" value="0"></label></div></section><section class="card"><h2>오늘 할 일</h2><div class="task-list">${Array.from({ length: 10 }, (_, i) => `<label><span>${i + 1}</span><input data-task="${i}" placeholder="예: 앤텔고객 충전"></label>`).join("")}</div></section><button class="primary activity-save" type="submit">이 날짜 기록 저장</button><div id="activityStatus" class="connection-status" hidden></div><div id="activityError" class="error"></div></form>`;
  root.firstElementChild.insertAdjacentHTML(
    "beforebegin",
    `<div class="view-tabs activity-tabs"><button class="active" data-activity-view="record">기록하기</button><button data-activity-view="stats">활동 통계</button></div>`,
  );
  root.insertAdjacentHTML(
    "beforeend",
    `<section id="activityStats" hidden><section class="card"><div class="section-head"><div><h2>활동 통계</h2><p class="help">월별 기록과 개통을 집계합니다.</p></div><input id="statsMonth" type="month" value="${today().slice(0, 7)}"></div><div id="statsKpis" class="stats-kpis"></div></section><section class="card"><h2>채널별 포스팅</h2><div id="postingBars" class="stat-bars"></div></section><section class="card"><h2>일자별 활동 추이</h2><div id="dailyBars" class="stat-bars"></div></section><section class="card"><h2>연간 요약</h2><div id="annualActivity" class="annual-table-wrap"></div></section><div id="statsError" class="error"></div></section>`,
  );
  const $ = (id) => document.getElementById(id),
    number = (id) => Number($(id).value || 0),
    postingInputs = [...root.querySelectorAll("[data-posting]")],
    taskInputs = [...root.querySelectorAll("[data-task]")];
  const totals = () => {
    $("postingTotal").textContent =
      `총 ${postingInputs.reduce((sum, input) => sum + Number(input.value || 0), 0)}건`;
  };
  postingInputs.forEach((input) => (input.oninput = totals));
  async function load() {
    const date = $("activityDate").value,
      [record, activations] = await Promise.all([
        supabase
          .from("daily_activities")
          .select("*")
          .eq("owner_id", me.id)
          .eq("activity_date", date)
          .maybeSingle(),
        supabase
          .from("customers")
          .select("*", { count: "exact", head: true })
          .eq("owner_id", me.id)
          .eq("activation_date", date),
      ]),
      { data, error } = record;
    if (error) {
      $("activityError").textContent = error.message;
      return;
    }
    $("activationTotal").textContent = `${activations.count || 0}건`;
    const content = data?.content || {},
      posts = content.postings || {};
    postingInputs.forEach(
      (input) => (input.value = posts[input.dataset.posting] || 0),
    );
    $("newTransfer").value = data?.new_transfer || 0;
    $("repurchase").value = data?.repurchase || 0;
    $("balance").value = data?.balance || 0;
    $("attendance").value = data?.attendance || 0;
    $("aSales").value = data?.a_sales || 0;
    $("bSales").value = data?.b_sales || 0;
    taskInputs.forEach(
      (input, i) => (input.value = (data?.tasks || [])[i] || ""),
    );
    totals();
    $("activityStatus").hidden = !data;
    if (data) {
      $("activityStatus").textContent = "저장된 기록을 불러왔습니다.";
    }
  }
  async function loadStats() {
    const month = $("statsMonth").value,
      year = Number(month.slice(0, 4)),
      { start, end } = monthRange(month),
      yearStart = `${year}-01-01`,
      yearEnd = `${year}-12-31`,
      [records, customers, annual] = await Promise.all([
        supabase
          .from("daily_activities")
          .select("*")
          .eq("owner_id", me.id)
          .gte("activity_date", start)
          .lte("activity_date", end)
          .order("activity_date"),
        supabase
          .from("customers")
          .select("activation_date")
          .eq("owner_id", me.id)
          .gte("activation_date", start)
          .lte("activation_date", end),
        supabase
          .from("daily_activities")
          .select("*")
          .eq("owner_id", me.id)
          .gte("activity_date", yearStart)
          .lte("activity_date", yearEnd),
      ]);
    if (records.error || customers.error || annual.error) {
      $("statsError").textContent = (
        records.error ||
        customers.error ||
        annual.error
      ).message;
      return;
    }
    const rows = records.data || [],
      posts = Object.fromEntries(
        postingFields.map(([key]) => [
          key,
          rows.reduce(
            (sum, row) => sum + Number(row.content?.postings?.[key] || 0),
            0,
          ),
        ]),
      ),
      postTotal = Object.values(posts).reduce((a, b) => a + b, 0),
      money = rows.reduce(
        (sum, row) =>
          sum + Number(row.new_transfer || 0) + Number(row.repurchase || 0),
        0,
      ),
      auto = rows.reduce(
        (sum, row) => sum + Number(row.a_sales || 0) + Number(row.b_sales || 0),
        0,
      );
    $("statsKpis").innerHTML =
      `<article><span>포스팅</span><b>${postTotal.toLocaleString()}건</b></article><article><span>개통</span><b>${(customers.data || []).length}건</b></article><article><span>양도금</span><b>${money.toLocaleString()}원</b></article><article><span>자동매출</span><b>${auto.toLocaleString()} NV</b></article>`;
    const maxPost = Math.max(1, ...Object.values(posts));
    $("postingBars").innerHTML = postingFields
      .map(
        ([key, label]) =>
          `<div><span>${label}</span><i><b style="width:${(posts[key] / maxPost) * 100}%"></b></i><strong>${posts[key]}</strong></div>`,
      )
      .join("");
    const byDay = new Map(
        rows.map((row) => [
          row.activity_date,
          Object.values(row.content?.postings || {}).reduce(
            (a, b) => a + Number(b || 0),
            0,
          ),
        ]),
      ),
      maxDay = Math.max(1, ...byDay.values());
    $("dailyBars").innerHTML =
      [...byDay]
        .map(
          ([date, value]) =>
            `<div><span>${date.slice(8)}일</span><i><b style="width:${(value / maxDay) * 100}%"></b></i><strong>${value}</strong></div>`,
        )
        .join("") || '<p class="help">이 달의 기록이 없습니다.</p>';
    const months = Array.from({ length: 12 }, (_, i) =>
      String(i + 1).padStart(2, "0"),
    );
    $("annualActivity").innerHTML =
      `<table class="annual-table"><thead><tr><th>구분</th>${months.map((m) => `<th>${Number(m)}월</th>`).join("")}</tr></thead><tbody><tr><th>포스팅</th>${months.map((m) => `<td>${(annual.data || []).filter((r) => r.activity_date.slice(5, 7) === m).reduce((s, r) => s + Object.values(r.content?.postings || {}).reduce((a, b) => a + Number(b || 0), 0), 0)}</td>`).join("")}</tr><tr><th>양도금</th>${months
        .map(
          (m) =>
            `<td>${(annual.data || [])
              .filter((r) => r.activity_date.slice(5, 7) === m)
              .reduce(
                (s, r) =>
                  s + Number(r.new_transfer || 0) + Number(r.repurchase || 0),
                0,
              )
              .toLocaleString()}</td>`,
        )
        .join("")}</tr></tbody></table>`;
  }
  root.querySelectorAll("[data-activity-view]").forEach(
    (button) =>
      (button.onclick = () => {
        const stats = button.dataset.activityView === "stats";
        root
          .querySelectorAll("[data-activity-view]")
          .forEach((item) => item.classList.toggle("active", item === button));
        $("activityForm").hidden = stats;
        $("activityStats").hidden = !stats;
        root.querySelector(".activity-hero").hidden = stats;
        root.querySelector("#activityDate").closest(".card").hidden = stats;
        if (stats) loadStats();
      }),
  );
  $("statsMonth").onchange = loadStats;
  $("activityDate").onchange = load;
  $("activityForm").onsubmit = async (event) => {
    event.preventDefault();
    $("activityError").textContent = "";
    const postings = Object.fromEntries(
        postingInputs.map((input) => [
          input.dataset.posting,
          Number(input.value || 0),
        ]),
      ),
      value = {
        owner_id: me.id,
        activity_date: $("activityDate").value,
        new_transfer: number("newTransfer"),
        repurchase: number("repurchase"),
        balance: number("balance"),
        attendance: number("attendance"),
        a_sales: number("aSales"),
        b_sales: number("bSales"),
        tasks: taskInputs.map((input) => input.value.trim()),
        content: { postings },
        updated_at: new Date().toISOString(),
      },
      { error } = await supabase
        .from("daily_activities")
        .upsert(value, { onConflict: "owner_id,activity_date" });
    if (error) $("activityError").textContent = error.message;
    else {
      $("activityStatus").hidden = false;
      $("activityStatus").textContent = "이 날짜의 기록을 저장했습니다.";
    }
  };
  await load();
}
