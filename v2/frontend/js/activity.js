import { supabase } from "./supabase.js?v=20260829-34";
import { localDate, monthRange } from "./date.js?v=20260829-25";
import { friendlyError } from "./errors.js?v=20260830-1";
const postingFields = [
  ["blog_sloom", "슬롭"],
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
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const QUESTS = [
  ["posting", "포스팅 / SNS 기록"],
  ["sales", "개통·매출 입력"],
  ["memo", "제목 메모"],
  ["todo", "오늘 할 일"],
];
export async function activityPage(root, me) {
  root.innerHTML = `<section class="card"><h2>일일업무일지</h2><label>기록할 날짜<input id="activityDate" type="date" value="${today()}"></label></section><section class="activity-hero"><span>오늘 개통</span><b id="activationTotal">0건</b></section><p class="quest-progress" id="questProgress">오늘 퀘스트 0/${QUESTS.length} 완료</p><form id="activityForm"><details class="card home-nrc quest" data-quest="posting" open><summary><h2>포스팅 / SNS 기록</h2><span class="quest-badge" id="questBadge-posting">미완료</span></summary><b id="postingTotal">총 0건</b><div class="quest-dice"><button type="button" class="secondary compact" id="questRoll">🎲 오늘의 퀘스트 뽑기</button><div id="questTargetsView" class="quest-targets"></div></div><div class="task-list" id="postingList"></div><div class="task-add-row"><select id="postingPicker"><option value="">채널 선택</option></select><button class="secondary compact" id="postingAdd" type="button">+ 채널 추가</button></div></details><details class="card home-nrc quest" data-quest="sales"><summary><h2>개통·매출 입력</h2><span class="quest-badge" id="questBadge-sales">미완료</span></summary><div class="activity-grid two"><label>신규개통양도금(원)<input id="newTransfer" type="number" min="0" value="0"></label><label>재구매요금양도금(원)<input id="repurchase" type="number" min="0" value="0"></label><label>현재요금잔액(원)<input id="balance" type="number" min="0" value="0"></label><label>앤보임 수강생<input id="attendance" type="number" min="0" value="0"></label><label>A 자동매출(NV)<input id="aSales" type="number" min="0" value="0"></label><label>B 자동매출(NV)<input id="bSales" type="number" min="0" value="0"></label></div></details><details class="card home-nrc quest" data-quest="memo"><summary><h2>제목 메모</h2><span class="quest-badge" id="questBadge-memo">미완료</span></summary><p class="help">한 줄에 제목 하나씩 입력하세요. 저장 시 이 날짜 기록에 함께 저장됩니다.</p><textarea id="postTitles" rows="6" placeholder="정지된 휴대폰 본인인증 방법"></textarea><button class="secondary compact" id="copyTitles" type="button">복사하기</button><div id="copyTitlesStatus" class="connection-status" hidden></div></details><details class="card home-nrc quest" data-quest="todo" open><summary><h2>오늘 할 일</h2><span class="quest-badge" id="questBadge-todo">미완료</span></summary><div class="task-list" id="taskList"></div><div class="task-add-row"><button class="secondary compact" id="taskAdd" type="button">+ 항목 추가</button><button class="secondary compact" id="downloadActivityIcs" type="button">📅 캘린더 파일 저장</button></div></details><button class="primary activity-save" type="submit">이 날짜 기록 저장</button><div id="activityStatus" class="connection-status" hidden></div><div id="activityError" class="error"></div></form>`;
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
    salesIds = [
      "newTransfer",
      "repurchase",
      "balance",
      "attendance",
      "aSales",
      "bSales",
    ];
  let questTargets = [];
  function rollQuestTargets() {
    const pool = [...postingFields],
      count = Math.min(pool.length, 2 + Math.floor(Math.random() * 2)),
      picked = [];
    while (picked.length < count && pool.length) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    questTargets = picked.map(([key]) => [
      key,
      2 + Math.floor(Math.random() * 4),
    ]);
    renderQuestTargets();
    updateQuestStatus();
  }
  function renderQuestTargets() {
    const view = $("questTargetsView");
    if (!questTargets.length) {
      view.innerHTML = "";
      return;
    }
    const activeMap = new Map(getPostingEntries());
    view.innerHTML = questTargets
      .map(([key, target]) => {
        const label = postingFields.find(([k]) => k === key)?.[1] || key,
          current = Number(activeMap.get(key) || 0),
          done = current >= target;
        return `<button type="button" class="quest-chip ${done ? "done" : ""}" data-quest-key="${key}">${done ? "✓ " : ""}${esc(label)} ${current}/${target}</button>`;
      })
      .join("");
    view.querySelectorAll("[data-quest-key]").forEach((chip) => {
      chip.onclick = () => {
        const key = chip.dataset.questKey;
        if (getPostingEntries().some(([k]) => k === key)) return;
        renderPostings([...getPostingEntries(), [key, 0]]);
        totals();
      };
    });
  }
  const getTaskValues = () =>
    [...$("taskList").querySelectorAll("[data-task]")].map((i) => i.value);
  function renderTasks(list) {
    const values = list.length ? list : ["", "", ""];
    $("taskList").innerHTML = values
      .map(
        (value, i) =>
          `<label class="task-row"><span>${i + 1}</span><input data-task value="${esc(value)}" placeholder="예: 앤텔고객 충전"><button class="task-remove" type="button" aria-label="항목 삭제">×</button></label>`,
      )
      .join("");
    $("taskList")
      .querySelectorAll("[data-task]")
      .forEach((input) => (input.oninput = updateQuestStatus));
    $("taskList")
      .querySelectorAll(".task-remove")
      .forEach((button, i) => {
        button.onclick = () => {
          const values = getTaskValues();
          values.splice(i, 1);
          renderTasks(values);
          updateQuestStatus();
        };
      });
  }
  const getPostingEntries = () =>
    [...$("postingList").querySelectorAll("[data-posting]")].map((input) => [
      input.dataset.posting,
      Number(input.value || 0),
    ]);
  function refreshPostingPicker() {
    const active = new Set(getPostingEntries().map(([key]) => key)),
      remaining = postingFields.filter(([key]) => !active.has(key));
    $("postingPicker").innerHTML =
      `<option value="">채널 선택</option>` +
      remaining
        .map(([key, label]) => `<option value="${key}">${label}</option>`)
        .join("");
    $("postingAdd").disabled = !remaining.length;
  }
  function renderPostings(entries) {
    $("postingList").innerHTML = entries.length
      ? entries
          .map(([key, value]) => {
            const label = postingFields.find(([k]) => k === key)?.[1] || key;
            return `<label class="task-row posting-row"><span>${esc(label)}</span><input type="number" min="0" value="${value}" data-posting="${key}"><button class="task-remove" type="button" data-remove="${key}" aria-label="채널 삭제">×</button></label>`;
          })
          .join("")
      : '<p class="help">아직 추가한 채널이 없습니다. 아래에서 채널을 선택해 추가하세요.</p>';
    $("postingList")
      .querySelectorAll("[data-posting]")
      .forEach((input) => (input.oninput = totals));
    $("postingList")
      .querySelectorAll("[data-remove]")
      .forEach((button) => {
        button.onclick = () => {
          renderPostings(
            getPostingEntries().filter(([key]) => key !== button.dataset.remove),
          );
          totals();
        };
      });
    refreshPostingPicker();
  }
  const questChecks = {
    posting: () => {
      if (!questTargets.length)
        return getPostingEntries().some(([, value]) => value > 0);
      const activeMap = new Map(getPostingEntries());
      return questTargets.every(
        ([key, target]) => Number(activeMap.get(key) || 0) >= target,
      );
    },
    sales: () => salesIds.some((id) => number(id) > 0),
    memo: () => $("postTitles").value.trim().length > 0,
    todo: () => getTaskValues().some((v) => v.trim().length > 0),
  };
  function updateQuestStatus() {
    let done = 0;
    QUESTS.forEach(([key]) => {
      const complete = questChecks[key]();
      if (complete) done++;
      const badge = $(`questBadge-${key}`);
      badge.textContent = complete ? "✓ 완료" : "미완료";
      badge.classList.toggle("done", complete);
    });
    $("questProgress").textContent =
      `오늘 퀘스트 ${done}/${QUESTS.length} 완료`;
  }
  const totals = () => {
    $("postingTotal").textContent =
      `총 ${getPostingEntries().reduce((sum, [, value]) => sum + value, 0)}건`;
    renderQuestTargets();
    updateQuestStatus();
  };
  $("questRoll").onclick = rollQuestTargets;
  salesIds.forEach((id) => ($(id).oninput = updateQuestStatus));
  $("postTitles").oninput = updateQuestStatus;
  $("taskAdd").onclick = () => {
    const values = getTaskValues();
    values.push("");
    renderTasks(values);
  };
  $("postingAdd").onclick = () => {
    const key = $("postingPicker").value;
    if (!key) return;
    renderPostings([...getPostingEntries(), [key, 0]]);
    totals();
  };
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
      $("activityError").textContent = friendlyError(error);
      return;
    }
    $("activationTotal").textContent = `${activations.count || 0}건`;
    const content = data?.content || {},
      posts = content.postings || {};
    questTargets = Array.isArray(content.questTargets)
      ? content.questTargets
      : [];
    renderPostings(
      postingFields
        .filter(([key]) => Number(posts[key] || 0) > 0)
        .map(([key]) => [key, Number(posts[key])]),
    );
    $("newTransfer").value = data?.new_transfer || 0;
    $("repurchase").value = data?.repurchase || 0;
    $("balance").value = data?.balance || 0;
    $("attendance").value = data?.attendance || 0;
    $("aSales").value = data?.a_sales || 0;
    $("bSales").value = data?.b_sales || 0;
    renderTasks(data?.tasks || []);
    $("postTitles").value = (content.postTitles || []).join("\n");
    totals();
    updateQuestStatus();
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
        $("questProgress").hidden = stats;
        root.querySelector("#activityDate").closest(".card").hidden = stats;
        if (stats) loadStats();
      }),
  );
  $("statsMonth").onchange = loadStats;
  $("activityDate").onchange = load;
  $("downloadActivityIcs").onclick = () => {
    const date = $("activityDate").value.replaceAll("-", ""),
      tasks = getTaskValues().map((v) => v.trim()).filter(Boolean);
    if (!date) return;
    const next = new Date(`${$("activityDate").value}T00:00:00`);
    next.setDate(next.getDate() + 1);
    const nextDate = `${next.getFullYear()}${String(next.getMonth() + 1).padStart(2, "0")}${String(next.getDate()).padStart(2, "0")}`,
      description = tasks.length
        ? tasks.map((task, i) => `${i + 1}. ${task}`).join("\n")
        : "등록된 할 일이 없습니다.",
      escaped = description
        .replaceAll("\\", "\\\\")
        .replaceAll("\n", "\\n")
        .replaceAll(",", "\\,"),
      calendar = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//NRC//Daily Activity//KO\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${date}\r\nDTEND;VALUE=DATE:${nextDate}\r\nSUMMARY:오늘 할 일\r\nDESCRIPTION:${escaped}\r\nEND:VEVENT\r\nEND:VCALENDAR`,
      link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([calendar], { type: "text/calendar;charset=utf-8" }),
    );
    link.download = `오늘할일-${$("activityDate").value}.ics`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  $("copyTitles").onclick = async () => {
    const status = $("copyTitlesStatus"),
      titles = $("postTitles")
        .value.split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    status.hidden = false;
    if (!titles.length) {
      status.textContent = "복사할 제목이 없습니다.";
      return;
    }
    const text = titles.map((title, i) => `${i + 1}. ${title}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = `${titles.length}개 제목을 복사했습니다.`;
    } catch {
      status.textContent = "클립보드 복사에 실패했습니다. 직접 선택해 복사해 주세요.";
    }
  };
  $("activityForm").onsubmit = async (event) => {
    event.preventDefault();
    $("activityError").textContent = "";
    const postings = Object.fromEntries(getPostingEntries()),
      postTitles = $("postTitles")
        .value.split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      value = {
        owner_id: me.id,
        activity_date: $("activityDate").value,
        new_transfer: number("newTransfer"),
        repurchase: number("repurchase"),
        balance: number("balance"),
        attendance: number("attendance"),
        a_sales: number("aSales"),
        b_sales: number("bSales"),
        tasks: getTaskValues().map((v) => v.trim()),
        content: { postings, postTitles, questTargets },
        updated_at: new Date().toISOString(),
      },
      { error } = await supabase
        .from("daily_activities")
        .upsert(value, { onConflict: "owner_id,activity_date" });
    if (error) $("activityError").textContent = friendlyError(error);
    else {
      $("activityStatus").hidden = false;
      $("activityStatus").textContent = "이 날짜의 기록을 저장했습니다.";
    }
  };
  await load();
}
