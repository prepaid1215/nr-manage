import { supabase } from "./supabase.js?v=20260829-34";
import { closingRound, withDeltas, toPeopleCsv, labelCodes, groupPeople, personValue, GRID_METRICS, monthDates, nextDate, buildGrid, toGridCsv } from "./records-logic.js?v=20261125-8";

// 기록 탭: 매일 저장된 코드별 대실적·소실적·실회선을 날짜별로 보고 엑셀(CSV)로 내려받는다.
// 표는 nrc_daily_metrics(RUN_051)에서 읽는다. 내 계정 자료만 보인다(RLS).

const number = (value) => Number(value || 0).toLocaleString("ko-KR");
const safe = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

const PAGE = 1000;
const COLUMNS = "metric_date,source_account_id,user_id,user_name,rank_name,ord_pv,max_pv,min_pv,real_lines,consumer_total_lines,snapshot_collected_at";

async function fetchAll(build) {
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

export async function recordsPage(root, me) {
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>기록</h2><p class="help" id="rcInfo">불러오는 중...</p></div></div><div id="rcError" class="error"></div><div id="rcBody"></div></section>`;
  const $ = (id) => document.getElementById(id);
  const state = { account: "", date: "", rows: [], sort: { key: "code", dir: 1 }, query: "", showMain: false };

  const latest = async (account) => {
    let query = supabase.from("nrc_daily_metrics").select("metric_date,source_account_id").eq("owner_id", me.id);
    if (account) query = query.eq("source_account_id", account);
    const { data, error } = await query.order("metric_date", { ascending: false }).limit(PAGE);
    if (error) throw error;
    return data || [];
  };

  const nearDate = async (account, date, direction) => {
    const query = supabase.from("nrc_daily_metrics").select("metric_date").eq("owner_id", me.id).eq("source_account_id", account);
    const { data, error } = await (direction < 0 ? query.lt("metric_date", date).order("metric_date", { ascending: false }) : query.gt("metric_date", date).order("metric_date", { ascending: true })).limit(1);
    if (error) throw error;
    return data?.[0]?.metric_date || "";
  };

  const loadDay = async (account, date) =>
    fetchAll(() => supabase.from("nrc_daily_metrics").select(COLUMNS).eq("owner_id", me.id).eq("source_account_id", account).eq("metric_date", date).order("user_id"));

  const sortValue = (person, key) => {
    if (!key.startsWith("sum.")) return personValue(person, key);
    const field = key.slice(4);
    const parts = [person.s1?.[field], person.s2?.[field]].filter((value) => value != null);
    return parts.length ? parts.reduce((sum, value) => sum + Number(value), 0) : null;
  };

  // 사람 단위로 묶고 검색·정렬을 적용한다. 값이 없는 칸은 정렬 방향과 상관없이 아래로 보낸다.
  const view = () => {
    const { people, singles } = groupPeople(state.rows);
    const text = state.query.trim().toLowerCase();
    const match = (name, ...codes) => !text || `${name || ""} ${codes.filter(Boolean).join(" ")}`.toLowerCase().includes(text);
    const list = people.filter((p) => match(p.name, p.code, p.s1?.user_id, p.s2?.user_id));
    const { key, dir } = state.sort;
    list.sort((a, b) => {
      const x = sortValue(a, key);
      const y = sortValue(b, key);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === "string") return x.localeCompare(y, "ko", { numeric: true }) * dir;
      return (x - y) * dir;
    });
    return { people: list, singles: singles.filter((row) => match(row.user_name, row.user_id)) };
  };

  const deltaHtml = (value) => {
    if (value == null) return '<small class="rc-d">-</small>';
    if (value === 0) return '<small class="rc-d">0</small>';
    return `<small class="rc-d ${value > 0 ? "up" : "down"}">${value > 0 ? "+" : ""}${number(value)}</small>`;
  };
  const linesHtml = (row) => (row.real_lines == null ? '<span class="rc-na">미수집</span>' : `${number(row.real_lines)}회선`);
  const valueCells = (row) =>
    row
      ? `<td class="num">${number(row.max_pv)}${deltaHtml(row.d_max)}</td><td class="num">${number(row.min_pv)}${deltaHtml(row.d_min)}</td><td class="num">${linesHtml(row)}${deltaHtml(row.d_real)}</td>`
      : '<td class="num">-</td><td class="num">-</td><td class="num">-</td>';

  const renderTable = () => {
    const { people, singles } = view();
    const arrow = (key) => (state.sort.key === key ? (state.sort.dir > 0 ? " ▲" : " ▼") : "");
    const th = (key, label, cls = "", title = "") => `<th data-rc-sort="${key}" class="${cls}"${title ? ` title="${title}"` : ""}>${label}${arrow(key)}</th>`;
    const sumTip = "두 서브 합계 기준으로 정렬";
    const head = `<tr><th>날짜</th>${th("name", "이름")}${th("rank", "직급")}<th>구분</th>${th("sum.max_pv", "대실적", "num", sumTip)}${th("sum.min_pv", "소실적", "num", sumTip)}${th("sum.real_lines", "회선수", "num", sumTip)}</tr>`;
    // 한 사람 = 서브1 줄 + 서브2 줄(세로). 본코드 보기를 켜면 맨 위에 본코드 줄이 하나 더 붙는다.
    const personRows = (p) => {
      const parts = [...(state.showMain ? [["본", p.main]] : []), ["서브1", p.s1], ["서브2", p.s2]];
      return parts
        .map(([label, row], index) => {
          const first = index === 0 ? `<td rowspan="${parts.length}" class="rc-date">${safe(state.date)}</td><td rowspan="${parts.length}" class="rc-person">${safe(p.name || "-")}<small class="rc-d">${safe(p.code)}</small></td><td rowspan="${parts.length}">${safe(p.rank || "-")}</td>` : "";
          return `<tr class="${index === 0 ? "rc-first" : ""}">${first}<td class="rc-label">${label}</td>${valueCells(row)}</tr>`;
        })
        .join("");
    };
    const body = people.length ? people.map(personRows).join("") : '<tr><td colspan="7" class="help">표시할 기록이 없습니다.</td></tr>';
    const singlesHtml = singles.length
      ? `<h3 class="rc-sub">서브가 없는 단독 코드 (${number(singles.length)}개)</h3><table class="rc-table"><thead><tr><th>이름</th><th>코드</th><th>직급</th><th class="num">대실적</th><th class="num">소실적</th><th class="num">회선수</th></tr></thead><tbody>${singles.map((row) => `<tr><td>${safe(row.user_name || "-")}</td><td>${safe(row.user_id)}</td><td>${safe(row.rank_name || "-")}</td><td class="num">${number(row.max_pv)}${deltaHtml(row.d_max)}</td><td class="num">${number(row.min_pv)}${deltaHtml(row.d_min)}</td><td class="num">${linesHtml(row)}${deltaHtml(row.d_real)}</td></tr>`).join("")}</tbody></table>`
      : "";
    $("rcTable").innerHTML = `<table class="rc-table"><thead>${head}</thead><tbody>${body}</tbody></table>${singlesHtml}`;
    $("rcCount").textContent = `${number(people.length)}명${singles.length ? ` · 단독 ${number(singles.length)}개` : ""}`;
    $("rcTable").querySelectorAll("[data-rc-sort]").forEach((cell) => {
      cell.onclick = () => {
        const key = cell.dataset.rcSort;
        state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : ["code", "name", "rank"].includes(key) ? 1 : -1 };
        renderTable();
      };
    });
  };

  let showDay = async (account, date) => {
    $("rcError").textContent = "";
    $("rcTable").innerHTML = '<p class="help">불러오는 중...</p>';
    try {
      const rows = await loadDay(account, date);
      const previousDate = await nearDate(account, date, -1);
      const previousRows = previousDate ? await loadDay(account, previousDate) : [];
      state.account = account;
      state.date = date;
      const labels = labelCodes(rows);
      state.rows = withDeltas(rows, previousRows).map((row) => ({ ...row, label: labels.get(String(row.user_id)) || "단독" }));
      state.previousDate = previousDate;
      const round = closingRound(date);
      $("rcDate").value = date;
      $("rcRound").innerHTML = round ? `<span class="rc-badge">${round}차 마감일</span>` : "";
      const collected = rows.map((row) => row.snapshot_collected_at).filter(Boolean).sort().pop();
      $("rcMeta").textContent = `${date}${previousDate ? ` · 비교 기준 ${previousDate}` : " · 비교할 이전 기록 없음"}${collected ? ` · 수집 ${new Date(collected).toLocaleString("ko-KR")}` : ""}`;
      renderTable();
    } catch (error) {
      $("rcError").textContent = `기록을 불러오지 못했습니다: ${error.message || error}`;
      $("rcTable").innerHTML = "";
    }
  };

  const go = async (direction) => {
    const target = await nearDate(state.account, state.date, direction);
    if (target) showDay(state.account, target);
    else $("rcError").textContent = direction < 0 ? "더 이전 기록이 없습니다." : "더 최근 기록이 없습니다.";
  };

  try {
    const recent = await latest("");
    if (!recent.length) {
      $("rcInfo").textContent = "아직 저장된 기록이 없습니다. 자동수집 예약이 돌고 자정이 지나면 첫 기록이 쌓입니다.";
      return;
    }
    const accounts = [...new Set(recent.map((row) => row.source_account_id))].sort();
    $("rcInfo").textContent = "매일 저장된 사람별 서브1·서브2의 대실적·소실적·회선수입니다. 이전 기록일과 비교한 증감이 함께 나옵니다.";
    $("rcBody").innerHTML = `<div class="view-tabs"><button class="active" id="rcTabDay" type="button">날짜별 보기</button><button id="rcTabOne" type="button">하루 보기</button></div><div id="rcGridPane"><div class="rc-controls"><label>기간(월)<input id="rcMonth" type="month"></label><label>값<select id="rcMetric">${GRID_METRICS.map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select></label><button class="secondary compact" id="rcGridCsv" type="button">엑셀(CSV) 내려받기</button></div><div class="rc-ptabs" id="rcPTabs"></div><select id="rcAddPerson" hidden></select><div class="rc-wrap" id="rcGridTable"></div><p class="help">위의 이름 탭을 누르면 그 사람의 서브1·서브2 기록이 날짜별로 나옵니다. 탭 끝의 ×는 탭 닫기, +는 사람 추가입니다. 노란 줄은 마감일(8일·15일·23일·말일)입니다. 기록이 없는 날은 "-"입니다. 기록은 매일 한 번 쌓이므로 처음에는 비어 있고 날이 지날수록 채워집니다.</p></div><div id="rcDayPane" hidden><div class="rc-controls"><label>계정<select id="rcAccount">${accounts.map((a) => `<option value="${safe(a)}">${safe(a)}</option>`).join("")}</select></label><div class="rc-datebox"><button class="secondary compact" id="rcPrev" type="button">◀ 이전</button><input id="rcDate" type="date"><button class="secondary compact" id="rcNext" type="button">다음 ▶</button></div><label>검색<input id="rcSearch" placeholder="이름 또는 코드"></label><label class="check"><input id="rcMain" type="checkbox"> 본코드도 보기</label><button class="secondary compact" id="rcCsv" type="button">엑셀(CSV) 내려받기</button></div><p class="help"><span id="rcRound"></span> <span id="rcMeta"></span> · <span id="rcCount"></span></p><div class="rc-wrap" id="rcTable"></div><p class="help">증감은 바로 이전에 기록된 날짜와 비교한 값입니다. 실회선이 "미수집"이면 그날 읽지 못한 값이며 0과 다릅니다. 마감일은 8일·15일·23일·말일입니다. 본코드는 마감 계산에만 쓰여서 기본으로 숨겼습니다(“본코드도 보기”로 표시). 이름 아래 작은 숫자는 본코드 번호입니다.</p></div>`;

    const first = async (account) => {
      const rows = await latest(account);
      if (rows.length) await showDay(account, rows[0].metric_date);
    };
    $("rcAccount").onchange = () => first($("rcAccount").value);
    $("rcPrev").onclick = () => go(-1);
    $("rcNext").onclick = () => go(1);
    $("rcDate").onchange = () => {
      if ($("rcDate").value) showDay(state.account, $("rcDate").value);
    };
    $("rcMain").onchange = () => {
      state.showMain = $("rcMain").checked;
      renderTable();
    };
    $("rcSearch").oninput = () => {
      state.query = $("rcSearch").value;
      renderTable();
    };
    $("rcCsv").onclick = () => {
      const { people, singles } = view();
      const blob = new Blob([toPeopleCsv(people, singles, state.date, state.account)], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `기록_${state.account}_${state.date}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    };
    // ---- 날짜별 보기 ----
    const grid = { codes: [], active: "", month: "", metric: "total" };
    const tabsKey = () => `nrc.records.tabs.${state.account}`;
    const saveTabs = () => {
      try {
        localStorage.setItem(tabsKey(), JSON.stringify({ codes: grid.codes, active: grid.active }));
      } catch {
        // 저장 공간을 못 써도 화면은 정상 동작한다.
      }
    };
    const loadTabs = () => {
      try {
        const saved = JSON.parse(localStorage.getItem(tabsKey()) || "null");
        return saved && Array.isArray(saved.codes) ? saved : null;
      } catch {
        return null;
      }
    };
    const peopleOf = () => groupPeople(state.rows).people.filter((p) => p.s1 || p.s2);
    const chosenPeople = () => {
      const all = peopleOf();
      return grid.codes.map((code) => all.find((p) => p.code === code)).filter(Boolean).map((p) => ({ code: p.code, name: p.name, s1: p.s1?.user_id || "", s2: p.s2?.user_id || "" }));
    };
    const activePerson = () => {
      const people = chosenPeople();
      return people.find((p) => p.code === grid.active) || people[0] || null;
    };
    const renderGridPickers = () => {
      const all = peopleOf();
      const people = chosenPeople();
      grid.codes = people.map((p) => p.code);
      grid.active = activePerson()?.code || "";
      $("rcAddPerson").innerHTML = `<option value="">사람 고르기...</option>${all.filter((p) => !grid.codes.includes(p.code)).map((p) => `<option value="${safe(p.code)}">${safe(p.name || p.code)} (${safe(p.code)})</option>`).join("")}`;
      $("rcPTabs").innerHTML = `${people
        .map((p) => `<div class="rc-ptab${p.code === grid.active ? " active" : ""}"><button type="button" data-rc-tab="${safe(p.code)}">${safe(p.name || p.code)}</button><a href="#" data-rc-del="${safe(p.code)}" title="탭 닫기">×</a></div>`)
        .join("")}<button type="button" class="rc-ptab-add" id="rcAddTab" title="사람 추가"${all.length === people.length ? " disabled" : ""}>+</button>`;
      $("rcPTabs").querySelectorAll("[data-rc-tab]").forEach((button) => {
        button.onclick = () => {
          grid.active = button.dataset.rcTab;
          saveTabs();
          renderGridPickers();
          drawGrid();
        };
      });
      $("rcPTabs").querySelectorAll("[data-rc-del]").forEach((link) => {
        link.onclick = (event) => {
          event.preventDefault();
          grid.codes = grid.codes.filter((code) => code !== link.dataset.rcDel);
          saveTabs();
          renderGridPickers();
          drawGrid();
        };
      });
      $("rcAddTab").onclick = () => {
        $("rcAddPerson").hidden = !$("rcAddPerson").hidden;
        if (!$("rcAddPerson").hidden) $("rcAddPerson").focus();
      };
    };
    const drawGrid = async () => {
      const person = activePerson();
      const people = person ? [person] : [];
      const target = $("rcGridTable");
      if (!people.length) {
        target.innerHTML = '<p class="help" style="padding:12px">오른쪽 + 버튼으로 사람을 추가하세요.</p>';
        return;
      }
      if (!grid.month) return;
      target.innerHTML = '<p class="help" style="padding:12px">불러오는 중...</p>';
      try {
        const dates = monthDates(grid.month);
        const codes = people.flatMap((p) => [p.s1, p.s2]).filter(Boolean);
        const rows = await fetchAll(() =>
          supabase.from("nrc_daily_metrics").select(COLUMNS).eq("owner_id", me.id).eq("source_account_id", state.account).in("user_id", codes).gte("metric_date", dates[0]).lte("metric_date", nextDate(dates[dates.length - 1])).order("metric_date"),
        );
        const metricLabel = GRID_METRICS.find(([key]) => key === grid.metric)?.[1].split(" ")[0] || "";
        const unit = grid.metric === "real_lines" ? "회선" : "";
        const data = buildGrid(rows, people, dates, grid.metric);
        grid.last = { data, people, metricLabel };
        // 마감일은 두 줄: 그날 줄 + 바로 아래 "최종마감N차"(마감일 다음날 0시 기록).
        const cell = (value) => (value == null ? '<td class="num rc-na">-</td>' : `<td class="num">${number(value)}${unit}</td>`);
        const dayRows = (row) =>
          row.final
            ? `<tr class="rc-final"><td class="rc-dayno">최종마감${row.round}차<small>${safe(nextDate(row.date))} 기록</small></td>${row.cells.map(cell).join("")}</tr>`
            : `<tr class="${row.round ? "rc-closing" : ""}"><td class="rc-dayno">${safe(row.date)}${row.round ? `<small>${row.round}차 마감일</small>` : ""}</td>${row.cells.map(cell).join("")}</tr>`;
        target.innerHTML = `<table class="rc-table rc-grid"><thead><tr><th>날짜</th>${people.map((p) => `<th class="num">서브1 ${safe(metricLabel)}<small class="rc-d">${safe(p.s1 || "-")}</small></th><th class="num">서브2 ${safe(metricLabel)}<small class="rc-d">${safe(p.s2 || "-")}</small></th>`).join("")}</tr></thead><tbody>${data
          .map(dayRows)
          .join("")}</tbody></table>`;
      } catch (error) {
        target.innerHTML = "";
        $("rcError").textContent = `기록을 불러오지 못했습니다: ${error.message || error}`;
      }
    };
    const resetGrid = () => {
      const saved = loadTabs();
      const exists = new Set(peopleOf().map((p) => p.code));
      const codes = (saved?.codes || []).filter((code) => exists.has(code));
      grid.codes = codes.length ? codes : peopleOf().slice(0, 3).map((p) => p.code);
      grid.active = codes.includes(saved?.active) ? saved.active : "";
      renderGridPickers();
      drawGrid();
    };
    $("rcTabDay").onclick = () => {
      $("rcTabDay").classList.add("active");
      $("rcTabOne").classList.remove("active");
      $("rcGridPane").hidden = false;
      $("rcDayPane").hidden = true;
    };
    $("rcTabOne").onclick = () => {
      $("rcTabOne").classList.add("active");
      $("rcTabDay").classList.remove("active");
      $("rcGridPane").hidden = true;
      $("rcDayPane").hidden = false;
    };
    $("rcMetric").onchange = () => {
      grid.metric = $("rcMetric").value;
      drawGrid();
    };
    $("rcMonth").onchange = () => {
      grid.month = $("rcMonth").value;
      drawGrid();
    };
    $("rcAddPerson").onchange = () => {
      const code = $("rcAddPerson").value;
      if (code) {
        grid.codes.push(code);
        grid.active = code;
        saveTabs();
      }
      $("rcAddPerson").hidden = true;
      renderGridPickers();
      drawGrid();
    };
    $("rcGridCsv").onclick = () => {
      if (!grid.last) return;
      const blob = new Blob([toGridCsv(grid.last.data, grid.last.people, grid.last.metricLabel)], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `기록_날짜별_${grid.last.people[0]?.name || ""}_${state.account}_${grid.month}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    };
    // 하루 보기에서 계정이나 날짜가 바뀌어 사람 목록이 달라지면 날짜별 보기 목록도 다시 만든다.
    const baseShowDay = showDay;
    showDay = async (account, date) => {
      const changedAccount = account !== state.account;
      await baseShowDay(account, date);
      if (!grid.month) {
        grid.month = date.slice(0, 7);
        $("rcMonth").value = grid.month;
      }
      if (changedAccount || !grid.codes.length) resetGrid();
      else renderGridPickers();
    };
    await first(accounts[0]);
  } catch (error) {
    $("rcInfo").textContent = "";
    $("rcError").textContent = `기록을 불러오지 못했습니다: ${error.message || error}`;
  }
}
