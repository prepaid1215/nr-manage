import { supabase } from "./supabase.js?v=20260829-34";
import { localDate } from "./date.js?v=20260829-25";
import { friendlyError } from "./errors.js?v=20260830-1";
import { isAppAdmin } from "./admin.js?v=20260831-16";
import { buildGrid, monthDates, nextDate } from "./records-logic.js?v=20261128-2";
const now = new Date(),
  yearNow = now.getFullYear(),
  monthNow = now.getMonth() + 1,
  fmt = (value) => Number(value || 0).toLocaleString("ko-KR");
export async function closingPage(root, me) {
  // 칸은 서브코드(회원번호+1, +2)로 구분하고, "대실적/소실적" 이름은 두 값을 비교해 큰 쪽·작은 쪽에 붙인다(값에 따라 바뀜).
  const baseNo = Number(String(me.member_no || "").replace(/[^0-9]/g, ""));
  // 이름 끝 표시 방식: ab = (A)/(B), code = (서브회원번호), both = (A/서브회원번호). 선택은 이 브라우저에 저장한다.
  let labelStyle = "both";
  try {
    const saved = localStorage.getItem("closingLabelStyle");
    if (["ab", "code", "both"].includes(saved)) labelStyle = saved;
  } catch {
    // 저장소를 못 써도 기본값으로 동작한다.
  }
  const codeOf = (slot) => {
      const letter = slot === 1 ? "A" : "B",
        code = baseNo ? String(baseNo + slot) : "";
      if (labelStyle === "ab" || !code) return `(${letter})`;
      return labelStyle === "code" ? `(${code})` : `(${letter}/${code})`;
    },
    sub1 = (prefix) => `${prefix} 서브1${codeOf(1)}`,
    sub2 = (prefix) => `${prefix} 서브2${codeOf(2)}`;
  root.innerHTML = `<div class="view-tabs closing-tabs"><button class="active" data-closing-view="daily" type="button">일일 마감</button><button data-closing-view="monthly" type="button">월 마감매출</button></div><div id="monthlyClosing" hidden><section class="card"><div class="section-head"><div><h2>마감매출</h2><p class="help">월별 1~4차 매출과 직급마감을 저장합니다.</p></div><div class="period-pick"><select id="closingLabelStyle" title="칸 이름에 붙는 표시 방식"><option value="both"${labelStyle === "both" ? " selected" : ""}>이름: A·B + 번호</option><option value="ab"${labelStyle === "ab" ? " selected" : ""}>이름: A·B</option><option value="code"${labelStyle === "code" ? " selected" : ""}>이름: 서브회원번호</option></select><input id="closingYear" type="number" value="${yearNow}"><select id="closingMonth">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === monthNow ? "selected" : ""}>${i + 1}월</option>`).join("")}</select></div></div></section><form id="closingForm"><section class="card finance-rounds">${[1, 2, 3, 4].map((round) => `<article><h2>${round}차</h2><label>${sub1("자동매출")}<input data-field="auto_sales_a" data-round="${round}" type="number" min="0" value="0"></label><label>${sub2("자동매출")}<input data-field="auto_sales_b" data-round="${round}" type="number" min="0" value="0"></label><label>${sub1("마감매출")}<input data-field="closing_sales_a" data-round="${round}" type="number" min="0" value="0"></label><label>${sub2("마감매출")}<input data-field="closing_sales_b" data-round="${round}" type="number" min="0" value="0"></label><label>요금카드매출<input data-field="card_sales" data-round="${round}" type="number" min="0" value="0"></label><label>직급마감<select data-field="rank_close" data-round="${round}"><option value="">-</option>${["GD", "RD", "ED", "DD", "SDD", "CDD", "PM", "IM"].map((v) => `<option>${v}</option>`).join("")}</select></label></article>`).join("")}</section><p class="help" id="closingAutoNote"></p><section class="finance-total"><span>이 달 마감매출</span><b id="closingTotal">0원</b></section><button class="primary" type="submit">전체 저장</button><div id="closingError" class="error"></div></form><section class="card"><h2>연간 요약</h2><div id="closingAnnual" class="annual-table-wrap"></div></section><section class="card"><h2>월마감 양식 만들기</h2><p class="help">위에서 고른 연/월 기준으로, 이번 달 개통 고객을 통신사·개통방법·가입유형으로 집계합니다.</p><button class="primary" id="makeMonthlyClose" type="button">양식 만들기</button><div id="monthlyCloseError" class="error"></div><pre id="monthlyClosePreview" class="daily-close-preview">연/월을 고르고 양식 만들기를 눌러주세요.</pre><div class="daily-close-actions"><button class="secondary" id="copyMonthlyClose" type="button">📋 복사하기</button><button class="secondary" id="downloadMonthlyClose" type="button" hidden>💾 JSON 다운로드</button></div><div id="monthlyCloseStatus" class="connection-status" hidden></div></section></div><div id="dailyClosing"><section class="card"><h2>일일 마감 내역 만들기</h2><div class="daily-close-form"><label>마감 날짜<input id="dailyCloseDate" type="date" value="${localDate()}"></label><label>현재요금잔액 (비워두면 전날 잔액에서 자동 차감)<input id="dailyBalance" type="number" min="0" placeholder="처음 한 번만 직접 입력하세요"></label><button class="primary" id="makeDailyClose" type="button">마감 내역 만들기</button></div><p class="connection-status">K망/L망 개통 대수는 고객 관리의 개통일과 통신사를 기준으로, 신규개통·재충전 금액은 활동 기록을 기준으로 자동 집계됩니다.</p><div id="dailyCloseError" class="error"></div></section><section class="card"><h2>미리보기</h2><pre id="dailyClosePreview" class="daily-close-preview">날짜를 선택하고 마감 내역 만들기를 눌러주세요.</pre><div class="daily-close-actions"><button class="secondary" id="copyDailyClose" type="button">📋 복사하기</button><button class="primary" id="calendarDailyClose" type="button">📅 캘린더 파일 저장</button></div><div id="dailyCloseStatus" class="connection-status" hidden></div></section></div>`;
  const $ = (id) => document.getElementById(id),
    inputs = [...root.querySelectorAll("[data-field]")],
    total = () => {
      $("closingTotal").textContent =
        `${fmt(inputs.filter((i) => ["closing_sales_a", "closing_sales_b"].includes(i.dataset.field)).reduce((s, i) => s + Number(i.value || 0), 0))}원`;
    };
  inputs.forEach((i) => (i.oninput = () => {
    total();
    refreshLabels();
  }));
  isAppAdmin().then((admin) => {
    $("downloadMonthlyClose").hidden = !admin;
  });
  let dailyCloseText = "";
  async function previousBalance(date) {
    const prev = new Date(`${date}T00:00:00`);
    prev.setDate(prev.getDate() - 1);
    const prevKey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
    const { data, error } = await supabase
      .from("daily_activities")
      .select("balance")
      .eq("owner_id", me.id)
      .eq("activity_date", prevKey)
      .maybeSingle();
    return error || !data ? null : Number(data.balance || 0);
  }
  async function makeDailyClose() {
    const date = $("dailyCloseDate").value;
    $("dailyCloseError").textContent = "";
    if (!date) return;
    const [customers, activity] = await Promise.all([
      supabase
        .from("customers")
        .select("network")
        .eq("owner_id", me.id)
        .eq("activation_date", date),
      supabase
        .from("daily_activities")
        .select("new_transfer,repurchase,balance")
        .eq("owner_id", me.id)
        .eq("activity_date", date)
        .maybeSingle(),
    ]);
    if (customers.error || activity.error) {
      $("dailyCloseError").textContent = (
        customers.error || activity.error
      ).message;
      return;
    }
    const rows = customers.data || [],
      kCount = rows.filter((row) =>
        /^(KT|K망)/i.test(row.network || ""),
      ).length,
      lCount = rows.filter((row) =>
        /^(LG|L망)/i.test(row.network || ""),
      ).length,
      newTransfer = Number(activity.data?.new_transfer || 0),
      repurchase = Number(activity.data?.repurchase || 0),
      [, month, day] = date.split("-").map(Number);
    let balance;
    if ($("dailyBalance").value) {
      balance = Number($("dailyBalance").value);
    } else if (activity.data?.balance) {
      balance = Number(activity.data.balance);
      $("dailyBalance").value = balance;
    } else {
      const prior = await previousBalance(date);
      balance = prior == null ? 0 : prior - newTransfer - repurchase;
      if (prior != null) $("dailyBalance").value = balance;
    }
    await supabase.from("daily_activities").upsert(
      { owner_id: me.id, activity_date: date, balance, updated_at: new Date().toISOString() },
      { onConflict: "owner_id,activity_date" },
    );
    dailyCloseText = `${me.name || "담당자"}\n신규개통\n${month}월 ${day}일\n신규개통\nK망  ${kCount}대\nL망  ${lCount}대\n신규개통  ${fmt(newTransfer)}원\n재충전  ${fmt(repurchase)}원\n총  ${fmt(newTransfer + repurchase)}원\n현재요금잔액  ${fmt(balance)}원`;
    $("dailyClosePreview").textContent = dailyCloseText;
    $("dailyCloseStatus").hidden = true;
  }
  // 각 차수·종류(자동매출/마감매출)마다 서브1·서브2 값을 비교해 큰 쪽에 "대실적", 작은 쪽에 "소실적"을 붙인다.
  // 값이 하나라도 비어 있으면 어느 쪽이 큰지 알 수 없으므로 "서브1/서브2"로 둔다.
  function refreshLabels() {
    for (const round of [1, 2, 3, 4]) {
      for (const [kind, prefix] of [["auto_sales", "자동매출"], ["closing_sales", "마감매출"]]) {
        const a = inputs.find((i) => Number(i.dataset.round) === round && i.dataset.field === `${kind}_a`),
          b = inputs.find((i) => Number(i.dataset.round) === round && i.dataset.field === `${kind}_b`);
        if (!a || !b) continue;
        const known = a.value !== "" && b.value !== "",
          aBig = Number(a.value) >= Number(b.value),
          nameA = known ? (aBig ? "대실적" : "소실적") : "서브1",
          nameB = known ? (aBig ? "소실적" : "대실적") : "서브2";
        a.parentElement.firstChild.textContent = `${prefix} ${nameA}${codeOf(1)}`;
        b.parentElement.firstChild.textContent = `${prefix} ${nameB}${codeOf(2)}`;
      }
    }
  }
  // 기록 탭의 내 서브1·서브2 값으로 빈 칸을 채운다(이미 값이 있는 칸은 그대로 둔다).
  // 자동매출 = 마감일 당일 저녁 기록(마감 전), 마감매출 = 마감일 아래 "최종마감" 기록(마감 후).
  // 첫째 칸 = 서브1, 둘째 칸 = 서브2, 값은 기록 탭 기본값인 총실적(본인+대+소). 기록이 없는 칸은 비워 둔다.
  async function autoFillFromRecords(year, month) {
    const note = $("closingAutoNote");
    note.textContent = "";
    const memberNo = Number(String(me.member_no || "").replace(/[^0-9]/g, ""));
    if (!memberNo) return;
    try {
      const monthText = `${year}-${String(month).padStart(2, "0")}`,
        dates = monthDates(monthText),
        last = dates[dates.length - 1],
        codes = [String(memberNo + 1), String(memberNo + 2)],
        cols = "metric_date,user_id,ord_pv,max_pv,min_pv",
        probe = await supabase.from("nrc_daily_metrics").select("record_kind").limit(1),
        hasKind = !probe.error;
      let daily = supabase.from("nrc_daily_metrics").select(cols).eq("owner_id", me.id).in("user_id", codes).gte("metric_date", dates[0]).lte("metric_date", nextDate(last));
      if (hasKind) daily = daily.eq("record_kind", "daily");
      const dailyRes = await daily;
      if (dailyRes.error) throw dailyRes.error;
      let finalRows = null;
      if (hasKind) {
        const finalRes = await supabase.from("nrc_daily_metrics").select(cols).eq("owner_id", me.id).eq("record_kind", "final").in("user_id", codes).gte("metric_date", dates[0]).lte("metric_date", last);
        if (finalRes.error) throw finalRes.error;
        finalRows = finalRes.data || [];
      }
      const grid = buildGrid(dailyRes.data || [], [{ code: String(memberNo), name: "", s1: codes[0], s2: codes[1] }], dates, "total", finalRows);
      let filled = 0;
      const put = (round, field, value) => {
        const input = inputs.find((i) => Number(i.dataset.round) === round && i.dataset.field === field);
        if (!input || value == null || input.value !== "") return;
        input.value = String(value);
        input.classList.add("auto-filled");
        filled += 1;
      };
      for (const round of [1, 2, 3, 4]) {
        const before = grid.find((row) => row.round === round && !row.final),
          after = grid.find((row) => row.round === round && row.final);
        if (before) {
          put(round, "auto_sales_a", before.cells[0]);
          put(round, "auto_sales_b", before.cells[1]);
        }
        if (after) {
          put(round, "closing_sales_a", after.cells[0]);
          put(round, "closing_sales_b", after.cells[1]);
        }
      }
      if (filled) note.textContent = `기록 탭의 내 서브1·서브2 값으로 빈 칸 ${filled}개를 채웠습니다(노란 칸). 자동매출은 마감일 당일 저녁 기록, 마감매출은 최종마감 기록입니다. 확인 후 "전체 저장"을 눌러야 저장됩니다.`;
    } catch {
      // 기록을 못 읽어도 직접 입력은 그대로 된다.
    }
  }
  async function load() {
    const year = Number($("closingYear").value),
      month = Number($("closingMonth").value),
      { data, error } = await supabase
        .from("closing_sales")
        .select("*")
        .eq("owner_id", me.id)
        .eq("year", year);
    if (error) {
      $("closingError").textContent = friendlyError(error);
      return;
    }
    inputs.forEach((input) => {
      const row = (data || []).find(
        (r) => r.month === month && r.round === Number(input.dataset.round),
      );
      input.value = row?.[input.dataset.field] || "";
      input.classList.remove("auto-filled");
    });
    await autoFillFromRecords(year, month);
    refreshLabels();
    total();
    $("closingAnnual").innerHTML = annualTable(data || [], ["closing_sales_a", "closing_sales_b"]);
  }
  $("closingYear").onchange = $("closingMonth").onchange = load;
  $("closingLabelStyle").onchange = () => {
    labelStyle = $("closingLabelStyle").value;
    try {
      localStorage.setItem("closingLabelStyle", labelStyle);
    } catch {
      // 저장하지 못해도 이번 화면에서는 바로 적용된다.
    }
    refreshLabels();
  };
  $("closingForm").onsubmit = async (e) => {
    e.preventDefault();
    const year = Number($("closingYear").value),
      month = Number($("closingMonth").value),
      values = [1, 2, 3, 4].map((round) => ({
        owner_id: me.id,
        year,
        month,
        round,
        ...Object.fromEntries(
          inputs
            .filter((i) => Number(i.dataset.round) === round)
            .map((i) => [
              i.dataset.field,
              i.dataset.field === "rank_close" ? i.value : Number(i.value || 0),
            ]),
        ),
        updated_at: new Date().toISOString(),
      })),
      { error } = await supabase
        .from("closing_sales")
        .upsert(values, { onConflict: "owner_id,year,month,round" });
    if (error) $("closingError").textContent = friendlyError(error);
    else load();
  };
  let monthlyCloseText = "",
    monthlyCloseData = null;
  async function makeMonthlyClose() {
    $("monthlyCloseError").textContent = "";
    const year = Number($("closingYear").value),
      month = Number($("closingMonth").value),
      start = `${year}-${String(month).padStart(2, "0")}-01`,
      end = `${year}-${String(month).padStart(2, "0")}-31`,
      { data, error } = await supabase
        .from("customers")
        .select("network,activation_method,subscription_type")
        .eq("owner_id", me.id)
        .gte("activation_date", start)
        .lte("activation_date", end);
    if (error) {
      $("monthlyCloseError").textContent = friendlyError(error);
      return;
    }
    const rows = data || [],
      bucket = (network) => {
        const scoped = rows.filter((r) =>
          network === "K" ? /^(KT|K망)/i.test(r.network || "") : /^(LG|L망)/i.test(r.network || ""),
        );
        const postpaid = scoped.filter((r) => r.subscription_type === "후불").length,
          rest = scoped.filter((r) => r.subscription_type !== "후불"),
          agentSmart = rest.filter((r) => r.activation_method === "앤스마트").length,
          platform = rest.filter((r) => r.activation_method === "플랫폼").length;
        return { agentSmart, platform, postpaid, total: agentSmart + platform + postpaid };
      },
      k = bucket("K"),
      l = bucket("L"),
      offline = rows.filter((r) => r.activation_method === "지점방문" && r.subscription_type !== "후불").length,
      total = k.total + l.total + offline;
    monthlyCloseText = `${me.name || "담당자"}\nK망 앤스마트 + 플랫폼 + 후불 : ${k.agentSmart}+${k.platform}+${k.postpaid}=${k.total}\nL망 앤스마트 + 플랫폼 + 후불 : ${l.agentSmart}+${l.platform}+${l.postpaid}=${l.total}\n타센터 및 오프라인 : ${offline}\n총합계 : ${total}`;
    monthlyCloseData = {
      manager: me.name || "담당자",
      year,
      month,
      k_network: { agent_smart: k.agentSmart, platform: k.platform, postpaid: k.postpaid, total: k.total },
      l_network: { agent_smart: l.agentSmart, platform: l.platform, postpaid: l.postpaid, total: l.total },
      offline,
      total,
      generated_at: new Date().toISOString(),
    };
    $("monthlyClosePreview").textContent = monthlyCloseText;
    $("monthlyCloseStatus").hidden = true;
  }
  $("makeMonthlyClose").onclick = makeMonthlyClose;
  $("copyMonthlyClose").onclick = async () => {
    if (!monthlyCloseText) await makeMonthlyClose();
    try {
      await navigator.clipboard.writeText(monthlyCloseText);
      $("monthlyCloseStatus").hidden = false;
      $("monthlyCloseStatus").textContent = "월마감 양식을 복사했습니다.";
    } catch {
      $("monthlyCloseError").textContent =
        "복사 권한이 없습니다. 미리보기 내용을 직접 선택해 주세요.";
    }
  };
  $("downloadMonthlyClose").onclick = async () => {
    if (!(await isAppAdmin())) return;
    if (!monthlyCloseData) await makeMonthlyClose();
    if (!monthlyCloseData) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(monthlyCloseData, null, 2)], {
        type: "application/json;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `월마감-${monthlyCloseData.year}-${String(monthlyCloseData.month).padStart(2, "0")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  root.querySelectorAll("[data-closing-view]").forEach(
    (button) =>
      (button.onclick = () => {
        const daily = button.dataset.closingView === "daily";
        root
          .querySelectorAll("[data-closing-view]")
          .forEach((item) => item.classList.toggle("active", item === button));
        $("monthlyClosing").hidden = daily;
        $("dailyClosing").hidden = !daily;
        if (daily) makeDailyClose();
      }),
  );
  $("makeDailyClose").onclick = makeDailyClose;
  $("dailyCloseDate").onchange = () => {
    $("dailyBalance").value = "";
    dailyCloseText = "";
    makeDailyClose();
  };
  makeDailyClose();
  $("dailyBalance").oninput = () => dailyCloseText && makeDailyClose();
  $("copyDailyClose").onclick = async () => {
    if (!dailyCloseText) await makeDailyClose();
    try {
      await navigator.clipboard.writeText(dailyCloseText);
      $("dailyCloseStatus").hidden = false;
      $("dailyCloseStatus").textContent = "마감 내역을 복사했습니다.";
    } catch {
      $("dailyCloseError").textContent =
        "복사 권한이 없습니다. 미리보기 내용을 직접 선택해 주세요.";
    }
  };
  $("calendarDailyClose").onclick = async () => {
    if (!dailyCloseText) await makeDailyClose();
    const date = $("dailyCloseDate").value.replaceAll("-", "");
    if (!date || !dailyCloseText) return;
    const next = new Date(`${$("dailyCloseDate").value}T00:00:00`);
    next.setDate(next.getDate() + 1);
    const nextDate = `${next.getFullYear()}${String(next.getMonth() + 1).padStart(2, "0")}${String(next.getDate()).padStart(2, "0")}`;
    const escaped = dailyCloseText
      .replaceAll("\\", "\\\\")
      .replaceAll("\n", "\\n")
      .replaceAll(",", "\\,");
    const calendar = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//NRC//Daily Closing//KO\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${date}\r\nDTEND;VALUE=DATE:${nextDate}\r\nSUMMARY:일일 마감\r\nDESCRIPTION:${escaped}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([calendar], { type: "text/calendar;charset=utf-8" }),
    );
    link.download = `일일마감-${$("dailyCloseDate").value}.ics`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  await load();
}
export async function commissionPage(root, me) {
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>수당 관리</h2><p class="help">월별 1~4차 수당을 기록합니다.</p></div><div class="period-pick"><input id="commYear" type="number" value="${yearNow}"><select id="commMonth">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === monthNow ? "selected" : ""}>${i + 1}월</option>`).join("")}</select></div></div></section><form id="commForm"><section class="card commission-inputs">${[1, 2, 3, 4].map((round) => `<label>${round}차<input data-comm-round="${round}" type="number" min="0" value="0"></label>`).join("")}<div class="finance-total"><span>수입/월</span><b id="commTotal">0원</b></div></section><button class="primary" type="submit">이 달 저장</button><div id="commError" class="error"></div></form><section class="card"><h2>연간 수당 요약</h2><div id="commAnnual" class="annual-table-wrap"></div></section>`;
  const $ = (id) => document.getElementById(id),
    inputs = [...root.querySelectorAll("[data-comm-round]")],
    total = () => {
      $("commTotal").textContent =
        `${fmt(inputs.reduce((s, i) => s + Number(i.value || 0), 0))}원`;
    };
  inputs.forEach((i) => (i.oninput = total));
  async function load() {
    const year = Number($("commYear").value),
      month = Number($("commMonth").value),
      { data, error } = await supabase
        .from("commissions")
        .select("*")
        .eq("owner_id", me.id)
        .eq("year", year);
    if (error) {
      $("commError").textContent = friendlyError(error);
      return;
    }
    inputs.forEach(
      (i) =>
        (i.value =
          (data || []).find(
            (r) => r.month === month && r.round === Number(i.dataset.commRound),
          )?.amount || 0),
    );
    total();
    $("commAnnual").innerHTML = annualTable(data || [], "amount");
  }
  $("commYear").onchange = $("commMonth").onchange = load;
  $("commForm").onsubmit = async (e) => {
    e.preventDefault();
    const year = Number($("commYear").value),
      month = Number($("commMonth").value),
      values = inputs.map((i) => ({
        owner_id: me.id,
        year,
        month,
        round: Number(i.dataset.commRound),
        amount: Number(i.value || 0),
        updated_at: new Date().toISOString(),
      })),
      { error } = await supabase
        .from("commissions")
        .upsert(values, { onConflict: "owner_id,year,month,round" });
    if (error) $("commError").textContent = friendlyError(error);
    else load();
  };
  await load();
}
function annualTable(rows, field) {
  const fields = Array.isArray(field) ? field : [field],
    value = (row) => fields.reduce((s, f) => s + Number(row?.[f] || 0), 0),
    months = Array.from({ length: 12 }, (_, i) => i + 1),
    rounds = [1, 2, 3, 4];
  return `<table class="annual-table"><thead><tr><th>차수</th>${months.map((m) => `<th>${m}월</th>`).join("")}<th>합</th></tr></thead><tbody>${rounds.map((round) => `<tr><th>${round}차</th>${months.map((month) => `<td>${fmt(value(rows.find((r) => r.month === month && r.round === round)))}</td>`).join("")}<td>${fmt(rows.filter((r) => r.round === round).reduce((s, r) => s + value(r), 0))}</td></tr>`).join("")}<tr><th>월합</th>${months.map((month) => `<td>${fmt(rows.filter((r) => r.month === month).reduce((s, r) => s + value(r), 0))}</td>`).join("")}<td>${fmt(rows.reduce((s, r) => s + value(r), 0))}</td></tr></tbody></table>`;
}
