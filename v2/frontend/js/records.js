import { supabase } from "./supabase.js?v=20260829-34";
import { closingRound, withDeltas, toPeopleCsv, labelCodes, groupPeople, personValue, GRID_METRICS, monthDates, nextDate, buildGrid, toGridCsv, matchPeople, trackedPeople, kstDate, snapshotRows, withProvisional, finalPreviewRows, FINAL_RULE_START, closingRound as closingRoundOf } from "./records-logic.js?v=20261125-21";

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

export async function recordsPage(root, me, tools = {}) {
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>기록</h2><p class="help" id="rcInfo">불러오는 중...</p></div></div><div id="rcError" class="error"></div><div id="rcBody"></div></section>`;
  const $ = (id) => document.getElementById(id);
  const state = { account: "", date: "", rows: [], sort: { key: "code", dir: 1 }, query: "", showMain: false, tracked: [] };

  // RUN_053의 record_kind 열이 있으면 일반 기록('daily')만 날짜별 기록으로 읽는다. 아직 없으면 필터 없이 이전 방식으로 읽는다.
  const dailyOnly = (query) => (state.noKind ? query : query.eq("record_kind", "daily"));

  const latest = async (account) => {
    let query = dailyOnly(supabase.from("nrc_daily_metrics").select("metric_date,source_account_id").eq("owner_id", me.id));
    if (account) query = query.eq("source_account_id", account);
    const { data, error } = await query.order("metric_date", { ascending: false }).limit(PAGE);
    if (error) throw error;
    return data || [];
  };

  const nearDate = async (account, date, direction) => {
    const query = dailyOnly(supabase.from("nrc_daily_metrics").select("metric_date").eq("owner_id", me.id).eq("source_account_id", account));
    const { data, error } = await (direction < 0 ? query.lt("metric_date", date).order("metric_date", { ascending: false }) : query.gt("metric_date", date).order("metric_date", { ascending: true })).limit(1);
    if (error) throw error;
    return data?.[0]?.metric_date || "";
  };

  const loadDay = async (account, date) =>
    fetchAll(() => dailyOnly(supabase.from("nrc_daily_metrics").select(COLUMNS).eq("owner_id", me.id).eq("source_account_id", account).eq("metric_date", date)).order("user_id"));

  // 표에 등록한 사람(RUN_052의 nrc_tracked_members). 표가 아직 없으면 빈 목록으로 보고 등록 기능만 막는다.
  const loadTracked = async () => {
    state.trackedError = "";
    const { data, error } = await supabase.from("nrc_tracked_members").select("user_id,user_name,rank_cd,rank_name,role,group_id").eq("owner_id", me.id).eq("source_account_id", state.account);
    if (error) {
      state.tracked = [];
      state.trackedError = error.message || String(error);
      return;
    }
    state.tracked = data || [];
  };

  // 오늘 칸 미리 보기용 최신 수집 결과. 실패하면 미리 보기만 없을 뿐 표는 그대로 쓴다. 60초 동안 다시 읽지 않는다.
  const latestSnapshot = async () => {
    const cached = state.snapshot;
    if (cached && cached.account === state.account && Date.now() - cached.at < 60000) return cached.data;
    let data = null;
    try {
      const result = await supabase
        .from("nrc_sync_snapshots")
        .select("collected_at,payload")
        .eq("owner_id", me.id)
        .eq("source_account_id", state.account)
        .eq("snapshot_type", "combined")
        .order("collected_at", { ascending: false })
        .limit(1);
      if (!result.error) data = result.data?.[0] || null;
    } catch {
      data = null;
    }
    state.snapshot = { account: state.account, at: Date.now(), data };
    return data;
  };

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
    const probe = await supabase.from("nrc_daily_metrics").select("record_kind").limit(1);
    state.noKind = Boolean(probe.error);
    const recent = await latest("");
    if (!recent.length) {
      $("rcInfo").textContent = "아직 저장된 기록이 없습니다. 자동수집 예약이 돌고 자정이 지나면 첫 기록이 쌓입니다.";
      return;
    }
    const accounts = [...new Set(recent.map((row) => row.source_account_id))].sort();
    $("rcInfo").textContent = "매일 저장된 사람별 서브1·서브2의 대실적·소실적·회선수입니다. 이전 기록일과 비교한 증감이 함께 나옵니다.";
    $("rcBody").innerHTML = `<div class="view-tabs"><button class="active" id="rcTabDay" type="button">날짜별 보기</button><button id="rcTabOne" type="button">하루 보기</button></div><div id="rcGridPane"><div class="rc-controls"><label>기간(월)<input id="rcMonth" type="month"></label><label>값<select id="rcMetric">${GRID_METRICS.map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select></label><button class="secondary compact" id="rcGridCsv" type="button">엑셀(CSV) 내려받기</button></div><div class="rc-ptabs" id="rcPTabs"></div><div id="rcAddBox" class="rc-addbox" hidden><input id="rcAddPerson" list="rcPeopleList" placeholder="이름 입력 (목록에 없으면 NRC에서 검색)" autocomplete="off"><button class="secondary compact" id="rcNrcFind" type="button">NRC에서 찾기</button><datalist id="rcPeopleList"></datalist></div><p class="help" id="rcLookupStatus"></p><div id="rcLookup"></div><div class="rc-wrap" id="rcGridTable"></div><p class="help">"전체" 탭은 탭으로 열어 둔 사람들의 서브1·서브2를 한 표로 보여 주고, 이름 탭은 그 사람만 보여 줍니다. 이름 탭 끝의 ×는 탭 닫기, +는 사람 추가입니다. 10단계 밖의 하위는 "NRC에서 찾기"로 찾은 뒤 "표에 등록"하면 다음 수집부터 매일 기록됩니다. 노란 줄은 마감일(8일·15일·23일·말일)입니다. 기록이 없는 날은 "-"입니다. 오늘 칸은 오늘 수집한 최신 값을 회색 기울임으로 미리 보여 주고, 공식 기록이 만들어지면 그 값으로 바뀝니다. 날짜 칸은 그날 저녁 6시~자정에 마지막으로 수집한 값이고, 마감일 아래의 "최종마감" 줄은 마감 다음날 0~6시에 마지막으로 수집한 값입니다. 공식 기록은 다음 날 오전 6시 30분 이후에 만들어지며, 그 시간대에 수집이 없으면 "-"로 둡니다. 기록은 매일 한 번 쌓이므로 처음에는 비어 있고 날이 지날수록 채워집니다.</p></div><div id="rcDayPane" hidden><div class="rc-controls"><label>계정<select id="rcAccount">${accounts.map((a) => `<option value="${safe(a)}">${safe(a)}</option>`).join("")}</select></label><div class="rc-datebox"><button class="secondary compact" id="rcPrev" type="button">◀ 이전</button><input id="rcDate" type="date"><button class="secondary compact" id="rcNext" type="button">다음 ▶</button></div><label>검색<input id="rcSearch" placeholder="이름 또는 코드"></label><label class="check"><input id="rcMain" type="checkbox"> 본코드도 보기</label><button class="secondary compact" id="rcCsv" type="button">엑셀(CSV) 내려받기</button></div><p class="help"><span id="rcRound"></span> <span id="rcMeta"></span> · <span id="rcCount"></span></p><div class="rc-wrap" id="rcTable"></div><p class="help">증감은 바로 이전에 기록된 날짜와 비교한 값입니다. 실회선이 "미수집"이면 그날 읽지 못한 값이며 0과 다릅니다. 마감일은 8일·15일·23일·말일입니다. 본코드는 마감 계산에만 쓰여서 기본으로 숨겼습니다(“본코드도 보기”로 표시). 이름 아래 작은 숫자는 본코드 번호입니다.</p></div>`;

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
    const ALL = "*all";
    const grid = { codes: [], active: ALL, month: "", metric: "total" };
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
    const peopleOf = () => {
      const recorded = groupPeople(state.rows).people.filter((p) => p.s1 || p.s2);
      return [...recorded, ...trackedPeople(state.tracked, new Set(recorded.map((p) => p.code)))];
    };
    const isTracked = (code) => state.tracked.some((row) => String(row.group_id || row.user_id) === String(code));
    const chosenPeople = () => {
      const all = peopleOf();
      return grid.codes.map((code) => all.find((p) => p.code === code)).filter(Boolean).map((p) => ({ code: p.code, name: p.name, s1: p.s1?.user_id || "", s2: p.s2?.user_id || "" }));
    };
    const activePerson = () => chosenPeople().find((p) => p.code === grid.active) || null;
    const renderGridPickers = () => {
      const all = peopleOf();
      const people = chosenPeople();
      grid.codes = people.map((p) => p.code);
      if (grid.active !== ALL && !activePerson()) grid.active = ALL;
      $("rcPeopleList").innerHTML = all.filter((p) => !grid.codes.includes(p.code)).map((p) => `<option value="${safe(p.name || p.code)} (${safe(p.code)})"></option>`).join("");
      $("rcPTabs").innerHTML = `<div class="rc-ptab${grid.active === ALL ? " active" : ""}"><button type="button" data-rc-tab="${ALL}" title="모든 사람을 한 번에 보기">전체</button></div>${people
        .map((p) => `<div class="rc-ptab${p.code === grid.active ? " active" : ""}"><button type="button" data-rc-tab="${safe(p.code)}">${safe(p.name || p.code)}</button><a href="#" data-rc-del="${safe(p.code)}" title="탭 닫기">×</a></div>`)
        .join("")}<button type="button" class="rc-ptab-add" id="rcAddTab" title="사람 추가·NRC에서 찾기">+</button>${grid.active !== ALL && isTracked(grid.active) ? '<button type="button" class="secondary compact" id="rcUntrack" title="이 사람을 매일 기록에서 뺍니다">등록 해제</button>' : ""}`;
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
          if (grid.active === link.dataset.rcDel) grid.active = ALL;
          saveTabs();
          renderGridPickers();
          drawGrid();
        };
      });
      $("rcAddTab").onclick = () => {
        $("rcAddBox").hidden = !$("rcAddBox").hidden;
        if (!$("rcAddBox").hidden) $("rcAddPerson").focus();
      };
      if ($("rcUntrack")) $("rcUntrack").onclick = untrack;
    };
    const untrack = async () => {
      const person = activePerson();
      if (!person) return;
      if (!confirm(`${person.name || person.code}의 등록을 해제할까요? 앞으로 이 사람은 매일 기록에 추가되지 않습니다. 이미 쌓인 기록은 남습니다.`)) return;
      try {
        const { error } = await supabase.from("nrc_tracked_members").delete().eq("owner_id", me.id).eq("source_account_id", state.account).eq("group_id", String(person.code));
        if (error) throw error;
        state.tracked = state.tracked.filter((row) => String(row.group_id || row.user_id) !== String(person.code));
        grid.codes = grid.codes.filter((code) => code !== person.code);
        grid.active = ALL;
        saveTabs();
        renderGridPickers();
        drawGrid();
        renderLookups();
      } catch (error) {
        $("rcError").textContent = `등록 해제에 실패했습니다: ${error.message || error}`;
      }
    };
    const drawGrid = async () => {
      const everyone = grid.active === ALL;
      const person = activePerson();
      const people = everyone ? chosenPeople() : person ? [person] : [];
      const target = $("rcGridTable");
      if (!people.length) {
        target.innerHTML = '<p class="help" style="padding:12px">표에 올려 둔 사람이 없습니다. 위의 + 로 사람을 추가하거나, 목록에 없으면 "NRC에서 찾기"로 찾아 "표에 등록"하세요.</p>';
        return;
      }
      if (!grid.month) return;
      target.innerHTML = '<p class="help" style="padding:12px">불러오는 중...</p>';
      try {
        const dates = monthDates(grid.month);
        const codes = people.flatMap((p) => [p.s1, p.s2]).filter(Boolean);
        const officialRows = await fetchAll(() =>
          dailyOnly(supabase.from("nrc_daily_metrics").select(COLUMNS).eq("owner_id", me.id).eq("source_account_id", state.account).in("user_id", codes).gte("metric_date", dates[0]).lte("metric_date", nextDate(dates[dates.length - 1]))).order("metric_date"),
        );
        // 마감일의 최종마감 값은 마감 다음날 0~6시 수집으로 만든 별도 기록(record_kind='final')이다.
        let officialFinal = null;
        if (!state.noKind) {
          officialFinal = await fetchAll(() =>
            supabase.from("nrc_daily_metrics").select(COLUMNS).eq("owner_id", me.id).eq("source_account_id", state.account).eq("record_kind", "final").in("user_id", codes).gte("metric_date", dates[0]).lte("metric_date", dates[dates.length - 1]).order("metric_date"),
          );
        }
        // 오늘이 표 범위(최종마감 줄이 쓰는 다음 날 포함)에 들면, 오늘 수집한 최신 값을 공식 기록이 없는 칸에만 미리 채운다.
        const today = kstDate(new Date());
        let rows = officialRows;
        let provisional = new Set();
        let finalRows = officialFinal;
        let finalProvisional = new Set();
        const snapshotNeeded = (today >= dates[0] && today <= nextDate(dates[dates.length - 1])) || (finalRows && dates.some((date) => closingRoundOf(date) && date >= FINAL_RULE_START && nextDate(date) === today));
        if (snapshotNeeded) {
          const snapshot = await latestSnapshot();
          if (today >= dates[0] && today <= nextDate(dates[dates.length - 1])) ({ rows, provisional } = withProvisional(officialRows, snapshotRows(snapshot, codes, today)));
          if (finalRows) {
            const preview = dates.filter((date) => closingRoundOf(date) && date >= FINAL_RULE_START).flatMap((date) => finalPreviewRows(snapshot, codes, date));
            ({ rows: finalRows, provisional: finalProvisional } = withProvisional(officialFinal, preview));
          }
        }
        const cellCodes = people.flatMap((p) => [p.s1, p.s2]);
        const metricLabel = GRID_METRICS.find(([key]) => key === grid.metric)?.[1].split(" ")[0] || "";
        const unit = grid.metric === "real_lines" ? "회선" : "";
        const data = buildGrid(rows, people, dates, grid.metric, finalRows);
        if (provisional.size) {
          // 이전 방식의 최종마감 줄(다음 날 기록)에는 오늘 미리 보기 값을 섞지 않고 공식 기록만 쓴다.
          const official = buildGrid(officialRows, people, dates, grid.metric, finalRows);
          data.forEach((row, index) => {
            if (row.final && !row.strict) row.cells = official[index].cells;
          });
        }
        grid.last = { data, people, metricLabel, everyone };
        // 마감일은 두 줄: 그날 줄 + 바로 아래 "최종마감N차"(마감일 다음날 0시 기록).
        const previewTip = "수집한 최신 값(진행 중)입니다. 공식 기록(다음 날 오전 6시 30분 이후)이 만들어지면 그 값으로 바뀝니다.";
        const cell = (value, preview) =>
          value == null ? '<td class="num rc-na">-</td>' : preview ? `<td class="num rc-prov" title="${previewTip}">${number(value)}${unit}</td>` : `<td class="num">${number(value)}${unit}</td>`;
        const cells = (row) => {
          // 새 규칙의 최종마감 줄은 마감일 기준 최종마감 기록을, 이전 규칙의 줄은 다음 날 일반 기록을 쓴다.
          const set = row.final && row.strict ? finalProvisional : provisional;
          const cellDate = row.final && !row.strict ? nextDate(row.date) : row.date;
          return row.cells.map((value, index) => cell(value, set.has(`${cellDate}|${cellCodes[index]}`))).join("");
        };
        const dayRows = (row) =>
          row.final
            ? `<tr class="rc-final"><td class="rc-dayno">최종마감${row.round}차<small>${safe(nextDate(row.date))}${row.strict ? " 새벽(0~6시) 수집" : " 기록"}</small></td>${cells(row)}</tr>`
            : `<tr class="${row.round ? "rc-closing" : ""}"><td class="rc-dayno">${safe(row.date)}${row.date === today ? "<small>오늘 · 진행 중</small>" : ""}${row.round ? `<small>${row.round}차 마감일</small>` : ""}</td>${cells(row)}</tr>`;
        const head = everyone
          ? `<tr><th rowspan="2" class="rc-stick">날짜</th>${people.map((p) => `<th colspan="2" class="rc-group">${safe(p.name || p.code)}</th>`).join("")}</tr><tr>${people.map((p) => `<th class="num">서브1<small class="rc-d">${safe(p.s1 || "-")}</small></th><th class="num">서브2<small class="rc-d">${safe(p.s2 || "-")}</small></th>`).join("")}</tr>`
          : `<tr><th class="rc-stick">날짜</th>${people.map((p) => `<th class="num">서브1 ${safe(metricLabel)}<small class="rc-d">${safe(p.s1 || "-")}</small></th><th class="num">서브2 ${safe(metricLabel)}<small class="rc-d">${safe(p.s2 || "-")}</small></th>`).join("")}</tr>`;
        target.innerHTML = `<table class="rc-table rc-grid"><thead>${head}</thead><tbody>${data
          .map(dayRows)
          .join("")}</tbody></table>`;
        // 머리글이 두 줄(이름 줄 + 서브 줄)일 때, 아래 줄이 위 줄(이름) 바로 밑에 붙도록 첫 줄 높이를 CSS에 알려 준다.
        const firstHeadRow = target.querySelector("thead tr");
        if (firstHeadRow) target.style.setProperty("--rc-head1", `${firstHeadRow.offsetHeight}px`);
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
      grid.active = codes.includes(saved?.active) ? saved.active : ALL;
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
    // ---- NRC에서 이름으로 찾기 ----
    // 이 PC의 NRC Sync가 NRC 회원검색으로 내 산하 회원(10단계 밖 포함)을 찾아 현재 매출 값을 읽어 온다. 저장하지는 않는다.
    const lookups = [];
    const plain = (value) => (value == null ? '<span class="rc-na">미수집</span>' : number(value));
    const payLabel = (payDate) => (/^\d{8}$/.test(payDate || "") ? `${payDate.slice(0, 4)}-${payDate.slice(4, 6)}-${payDate.slice(6)}` : payDate || "-");
    const renderLookups = () => {
      $("rcLookup").innerHTML = lookups
        .map((item, index) => {
          const body = item.members.length
            ? item.members
                .map((m) =>
                  m.error
                    ? `<tr><td>${safe(m.role)}</td><td>${safe(m.userId)}</td><td colspan="7" class="rc-na">조회 실패: ${safe(m.error)}</td></tr>`
                    : `<tr><td>${safe(m.role)}</td><td>${safe(m.memberNo || m.userId)}</td><td>${safe(m.rankNewName || m.rankName || "-")}</td><td>${safe(m.sponsorName || "-")}</td><td class="num">${number(m.ordPv)}</td><td class="num">${number(m.maxPv)}</td><td class="num">${number(m.minPv)}</td><td class="num">${plain(m.realLines)}</td><td class="num">${plain(m.consumerTotalLines)}</td></tr>`,
                )
                .join("")
            : `<tr><td colspan="9" class="help">내 산하 회원 중 "${safe(item.name)}"을(를) 찾지 못했습니다. 이름이 정확한지 확인해 주세요.</td></tr>`;
          const more = item.total > item.members.length ? ` · 일치 ${number(item.total)}명 중 ${number(item.members.length)}명만 표시` : "";
          const groups = [...new Set(item.members.filter((m) => m.group).map((m) => String(m.group)))];
          const recordedCodes = new Set(groupPeople(state.rows).people.map((p) => p.code));
          const registerButtons = groups
            .map((group) => {
              const rows = item.members.filter((m) => String(m.group) === group);
              const label = groups.length > 1 ? ` ${safe(rows.find((m) => m.memberNo)?.memberNo || group)}` : "";
              if (rows.some((m) => m.error)) return `<span class="help">${label} 일부 코드를 읽지 못해 등록할 수 없습니다. 다시 찾아 주세요.</span>`;
              if (recordedCodes.has(group)) return `<span class="help">${label} 이미 매일 기록되는 사람입니다.</span>`;
              if (isTracked(group)) return `<span class="help">${label} 표에 등록됨 ✓ — 다음 수집부터 매일 기록됩니다.</span>`;
              return `<button class="compact" type="button" data-rc-register="${index}:${safe(group)}">표에 등록${label}</button>`;
            })
            .join("");
          const actions = registerButtons ? `<div class="rc-lookup-actions">${registerButtons}</div>` : "";
          return `<div class="rc-lookup"><div class="rc-lookup-head"><b>NRC 검색: ${safe(item.name)}</b><span class="help">${payLabel(item.payDate)} 마감차수 기준 · ${new Date(item.at).toLocaleTimeString("ko-KR")} 조회${more}</span><a href="#" data-rc-lookup-del="${index}" title="닫기">×</a></div><div class="rc-wrap"><table class="rc-table"><thead><tr><th>구분</th><th>회원번호</th><th>직급</th><th>후원인</th><th class="num">본인NV</th><th class="num">대실적</th><th class="num">소실적</th><th class="num">실회선</th><th class="num">총회선</th></tr></thead><tbody>${body}</tbody></table></div>${actions}</div>`;
        })
        .join("");
      $("rcLookup").querySelectorAll("[data-rc-register]").forEach((button) => {
        button.onclick = () => {
          const [index, group] = button.dataset.rcRegister.split(":");
          registerGroup(Number(index), group);
        };
      });
      $("rcLookup").querySelectorAll("[data-rc-lookup-del]").forEach((link) => {
        link.onclick = (event) => {
          event.preventDefault();
          lookups.splice(Number(link.dataset.rcLookupDel), 1);
          renderLookups();
        };
      });
    };
    // 찾은 사람(본·서브1·서브2)을 표에 등록한다. 수집기가 다음 수집부터 함께 조회해 매일 기록한다.
    const registerGroup = async (index, group) => {
      const item = lookups[index];
      const members = (item?.members || []).filter((m) => String(m.group) === String(group));
      if (!members.length || members.some((m) => m.error)) return;
      const account = item.sourceAccountId || state.account;
      if (account !== state.account) {
        $("rcError").textContent = "지금 보고 있는 계정과 다른 계정으로 찾은 결과라 등록할 수 없습니다. 같은 계정에서 다시 찾아 주세요.";
        return;
      }
      $("rcError").textContent = "";
      const rows = members.map((m) => ({
        owner_id: me.id,
        source_account_id: account,
        user_id: String(m.userId),
        user_name: m.userName || item.name,
        rank_cd: m.rankCd || null,
        rank_name: m.rankNewName || m.rankName || null,
        role: m.role,
        group_id: String(group),
      }));
      try {
        const { error } = await supabase.from("nrc_tracked_members").upsert(rows, { onConflict: "owner_id,source_account_id,user_id" });
        if (error) throw error;
        const ids = new Set(rows.map((row) => row.user_id));
        state.tracked = [...state.tracked.filter((row) => !ids.has(String(row.user_id))), ...rows.map(({ user_id, user_name, rank_cd, rank_name, role, group_id }) => ({ user_id, user_name, rank_cd, rank_name, role, group_id }))];
        if (!grid.codes.includes(String(group))) grid.codes.push(String(group));
        grid.active = String(group);
        saveTabs();
        renderGridPickers();
        drawGrid();
        renderLookups();
        $("rcLookupStatus").textContent = "표에 등록했습니다. 다음 수집부터 함께 조회해 기록하고, 첫 기록은 등록 뒤 저녁(18~24시) 수집을 마친 다음 날 오전 6시 30분 이후에 생깁니다.";
      } catch (error) {
        const message = String(error.message || error);
        $("rcError").textContent = /nrc_tracked_members|schema cache|does not exist/.test(message)
          ? "표에 등록하는 기능이 아직 준비되지 않았습니다. Supabase에서 RUN_052_TRACKED_MEMBERS.sql을 한 번 실행해야 합니다."
          : `표에 등록하지 못했습니다: ${message}`;
      }
    };
    let lookingUp = false;
    const nrcLookup = async (rawName) => {
      const name = String(rawName || "").trim();
      if (!name || lookingUp) return;
      if (!tools.lookupMember) {
        $("rcError").textContent = "NRC 검색을 사용할 수 없습니다. 페이지를 새로고침해 주세요.";
        return;
      }
      lookingUp = true;
      $("rcNrcFind").disabled = true;
      $("rcError").textContent = "";
      $("rcLookupStatus").textContent = `NRC에서 "${name}"을(를) 찾는 중입니다. 로그인부터 하므로 30초~1분 걸립니다...`;
      try {
        const result = await tools.lookupMember(name, state.account);
        lookups.unshift({ name: result.name || name, payDate: result.payDate, total: result.total || 0, members: result.members || [], sourceAccountId: result.sourceAccountId || state.account, at: Date.now() });
        renderLookups();
        $("rcAddPerson").value = "";
      } catch (error) {
        $("rcError").textContent = `NRC에서 찾지 못했습니다: ${error.message || error}`;
      } finally {
        lookingUp = false;
        $("rcNrcFind").disabled = false;
        $("rcLookupStatus").textContent = "";
      }
    };
    $("rcNrcFind").onclick = () => nrcLookup($("rcAddPerson").value);
    // 이름(또는 코드 일부)을 입력하면 한 명으로 정해질 때 탭이 추가된다. 이미 열린 탭이면 그 탭으로 이동한다.
    const addByText = () => {
      const text = $("rcAddPerson").value.trim();
      if (!text) return;
      const matches = matchPeople(peopleOf(), text);
      if (!matches.length) {
        nrcLookup(text); // 기록 목록에 없으면 NRC에서 이름으로 찾는다(10단계 밖의 하위 포함).
        return;
      }
      if (matches.length !== 1) {
        $("rcError").textContent = `"${text}"와 일치하는 사람이 ${matches.length}명입니다. 이름을 더 입력하거나 목록에서 고르세요.`;
        return;
      }
      $("rcError").textContent = "";
      const code = matches[0].code;
      if (!grid.codes.includes(code)) grid.codes.push(code);
      grid.active = code;
      saveTabs();
      $("rcAddPerson").value = "";
      $("rcAddBox").hidden = true;
      renderGridPickers();
      drawGrid();
    };
    $("rcAddPerson").onchange = addByText;
    $("rcAddPerson").onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addByText();
      }
    };
    $("rcGridCsv").onclick = () => {
      if (!grid.last) return;
      const blob = new Blob([toGridCsv(grid.last.data, grid.last.people, grid.last.metricLabel)], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `기록_날짜별_${grid.last.everyone ? "전체" : grid.last.people[0]?.name || ""}_${state.account}_${grid.month}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    };
    // 하루 보기에서 계정이나 날짜가 바뀌어 사람 목록이 달라지면 날짜별 보기 목록도 다시 만든다.
    const baseShowDay = showDay;
    showDay = async (account, date) => {
      const changedAccount = account !== state.account;
      await baseShowDay(account, date);
      if (changedAccount) await loadTracked();
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
