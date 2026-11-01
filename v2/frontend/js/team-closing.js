import { supabase } from "./supabase.js?v=20260829-34";
import { closingPeriodForDate } from "./performance-calculator.js?v=20261031-4";

const fmt = (value) => Number(value || 0).toLocaleString("ko-KR");
const safe = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const th = (label) => `<th style="text-align:left;padding:4px 6px">${label}</th>`;
const td = (html) => `<td style="padding:4px 6px;border-top:1px solid #e5e7eb">${html}</td>`;
const man = (nv) => (nv ? Math.round(Number(nv) / 10000) : "");

// 팀 탭 맨 위: NRC 계보 기준으로 내 아래 전체의 마감 오더·현황과 앱 가입 현황을 보여준다.
// (각자 자기 아래 전체의 팀장이다. DB 함수가 없거나 아래에 사람이 없으면 해당 칸은 비어 있다.)
export async function mountTeamClosing(root) {
  if (!root) return;
  const period = closingPeriodForDate(new Date());
  root.innerHTML =
    '<div data-tc="gather"></div><div data-tc="mine"></div><div data-tc="join"></div><div data-tc="orders"></div><div data-tc="team"></div>';
  const part = (name) => root.querySelector(`[data-tc="${name}"]`);

  const renderMine = async () => {
    const box = part("mine");
    const { data: rows, error } = await supabase.rpc("get_my_closing_order", {
      p_period_id: period.periodId,
    });
    if (error || !Array.isArray(rows) || !rows[0]) {
      box.innerHTML = "";
      return;
    }
    const order = rows[0];
    box.innerHTML = `<div class="card" style="margin:8px 0"><b>받은 오더 · ${period.year}년 ${period.month}월 ${period.round}차</b><div class="help">대 ${fmt(order.major_target)} / 소 ${fmt(order.minor_target)} (${safe(order.ordered_by_name || "상위")} 설정) · 실적 탭의 마감 계산기에서 "오더 목표 적용"으로 불러옵니다.</div></div>`;
  };

  const renderOrderTable = async (partName, rpcName, title, help, emptyHtml = "") => {
    const box = part(partName);
    const { data: rows, error } = await supabase.rpc(rpcName, {
      p_period_id: period.periodId,
    });
    if (error || !Array.isArray(rows) || !rows.length) {
      box.innerHTML = error ? "" : emptyHtml;
      return;
    }
    const startsAt = new Date(`${period.startDate}T00:00:00`);
    const body = rows
      .map((row) => {
        const id = safe(row.member_no);
        const done =
          row.verified !== false &&
          row.plan_status === "DONE" &&
          row.completion &&
          new Date(row.completed_at || row.completion.completedAt) >= startsAt;
        const state = done
          ? `✅ 완료 · 대 ${fmt(row.completion.majorNv)} / 소 ${fmt(row.completion.minorNv)}`
          : row.verified === false
            ? "⚠ 수집 확인 전 (마감은 인정 안 됨)"
            : "⏳ 대기";
        const input = (kind, value) =>
          `<input type="number" min="1" step="1" style="width:64px" data-order-${kind}="${id}" value="${value}">`;
        return `<tr>${td(`${safe(row.member_name || "")} (${id})`)}${td(
          `${input("major", man(row.major_target))} / ${input("minor", man(row.minor_target))} 만`,
        )}${td(state)}${td(
          `<button type="button" class="compact" data-order-save="${id}">저장</button> <button type="button" class="compact" data-order-delete="${id}">지우기</button>${
            row.ordered_by_name ? `<small> · ${safe(row.ordered_by_name)} 설정</small>` : ""
          }`,
        )}</tr>`;
      })
      .join("");
    box.innerHTML = `<div class="card" style="margin:8px 0"><b>${title} · ${period.year}년 ${period.month}월 ${period.round}차</b><div class="help">${help} 목표는 만 단위로 입력합니다 (40 = 40만 NV). 받는 사람은 마감 계산기에서 "오더 목표 적용"으로 불러옵니다.</div><table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr>${th("사업자")}${th("오더 대/소")}${th("상태")}${th("")}</tr></thead><tbody>${body}</tbody></table><div data-tc-msg class="help"></div></div>`;
  };

  // 관리(오더)는 항상 계보 위 계정이 한다. 팀은 사람을 묶어서 서로 뭘 했는지 보는 용도다.
  const renderOrders = () =>
    renderOrderTable(
      "orders",
      "get_downline_closing_status",
      "팀 마감 오더·현황",
      "내 계보 아래 앱 계정입니다. 오더는 계보 위 계정이 정합니다.",
    );

  const teamGuide =
    '<div class="card" style="margin:8px 0"><b>마케팅 모임 활동 현황</b><div class="help">모임은 계보와 상관없이 사람을 한 묶음으로 묶어서 서로 뭘 했는지 확인하는 용도입니다(관리·오더는 계보 위 계정이 합니다). 위 "마케팅 모임"에서 모임을 만들고 초대코드를 보내거나, 받은 초대코드로 합류하세요. 합류하면 이 칸에 서로의 활동이 나타납니다.</div></div>';

  // 마케팅 모임: 만든 사람은 팀장이 아니라 초대코드를 보내는 사람일 뿐이다(합류해도 누구에게도
  // 실적·계보 읽기 권한이 생기지 않는다). DB 함수가 없으면 이 칸은 보이지 않는다.
  const renderGatherings = async () => {
    const box = part("gather");
    const { data: rows, error } = await supabase.rpc("get_my_gatherings");
    if (error || !Array.isArray(rows)) {
      box.innerHTML = "";
      return;
    }
    const list = rows
      .map(
        (row) =>
          `<div style="padding:6px 0;border-top:1px solid #e5e7eb"><b>${safe(row.team_name)}</b> · ${fmt(row.member_count)}명${
            row.made_by_me
              ? ` <button type="button" class="compact" data-gather-invite="${safe(row.team_id)}">초대코드 만들기</button><span data-gather-code="${safe(row.team_id)}" class="help"></span>`
              : ""
          }</div>`,
      )
      .join("");
    box.innerHTML = `<div class="card" style="margin:8px 0"><b>마케팅 모임</b><div class="help">계보와 상관없이 사람을 한 묶음으로 묶어 서로 뭘 했는지 확인하는 모임입니다. 만든 사람은 팀장이 아니라 초대코드를 보내는 사람일 뿐이고, 합류해도 누구에게도 실적·계보 읽기 권한이 생기지 않습니다. 관리·오더는 계보 위 계정이 합니다.</div>${list || '<div class="help">아직 속한 모임이 없습니다.</div>'}<form data-gather-create style="margin-top:8px"><input name="name" placeholder="모임 이름 (예: 마케팅 모임)" minlength="2" required> <button type="submit" class="compact">모임 만들기</button></form><form data-gather-join style="margin-top:6px"><input name="code" placeholder="받은 초대코드" required> <button type="submit" class="compact">코드로 합류</button></form><div data-gather-msg class="help"></div></div>`;
  };

  root.addEventListener("submit", async (event) => {
    const create = event.target.closest("[data-gather-create]");
    const join = event.target.closest("[data-gather-join]");
    if (!create && !join) return;
    event.preventDefault();
    const message = root.querySelector("[data-gather-msg]");
    const { error, data } = create
      ? await supabase.rpc("create_gathering", { p_name: create.elements.name.value })
      : await supabase.rpc("join_gathering", { p_code: join.elements.code.value });
    if (error) {
      message.textContent = error.message;
      return;
    }
    await renderGatherings();
    await renderTeamActivity();
    const done = root.querySelector("[data-gather-msg]");
    if (done) {
      done.textContent = create
        ? "모임을 만들었습니다. 초대코드를 만들어 보내세요."
        : `${data?.[0]?.team_name || "모임"}에 합류했습니다.`;
    }
  });

  const renderTeamActivity = async () => {
    const box = part("team");
    const monthStart = `${period.year}-${String(period.month).padStart(2, "0")}-01`;
    const lastDay = new Date(period.year, period.month, 0).getDate();
    const monthEnd = `${period.year}-${String(period.month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    const { data: rows, error } = await supabase.rpc("get_team_activity_summary", {
      p_from: monthStart,
      p_to: monthEnd,
      p_period_id: period.periodId,
    });
    if (error || !Array.isArray(rows)) {
      box.innerHTML = "";
      return;
    }
    if (!rows.length) {
      box.innerHTML = teamGuide;
      return;
    }
    const startsAt = new Date(`${period.startDate}T00:00:00`);
    const body = rows
      .map((row) => {
        const done =
          row.verified !== false &&
          row.plan_status === "DONE" &&
          row.completion &&
          new Date(row.completed_at || row.completion.completedAt) >= startsAt;
        const closing = done
          ? `✅ 완료 · 대 ${fmt(row.completion.majorNv)} / 소 ${fmt(row.completion.minorNv)}`
          : row.verified === false
            ? "⚠ 수집 확인 전"
            : "⏳ 대기";
        return `<tr>${td(`${safe(row.member_name || "")} (${safe(row.member_no)})${row.is_me ? " · 나" : ""}`)}${td(
          row.last_activity ? safe(row.last_activity) : "-",
        )}${td(`${fmt(row.activity_days)}일`)}${td(`${fmt(row.activation_count)}건`)}${td(
          `${fmt(row.posting_count)}건`,
        )}${td(closing)}</tr>`;
      })
      .join("");
    box.innerHTML = `<div class="card" style="margin:8px 0"><b>마케팅 팀 활동 현황 · ${period.year}년 ${period.month}월</b><div class="help">팀(${safe(rows[0].team_name || "")})에 합류한 사람끼리 서로 이번 달 활동 개수를 봅니다. 고객 이름·전화번호 같은 내용은 보이지 않고 개수만 보입니다. 오더는 계보 위 계정이 정합니다.</div><table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr>${th("사람")}${th("마지막 기록")}${th("일지")}${th("개통")}${th("포스팅")}${th("마감(이번 차수)")}</tr></thead><tbody>${body}</tbody></table></div>`;
  };

  const renderJoin = async () => {
    const box = part("join");
    const { data: rows, error } = await supabase.rpc("get_downline_signup_status");
    if (error || !Array.isArray(rows) || !rows.length) {
      box.innerHTML = "";
      return;
    }
    // 매출자(사업을 하지 않고 수당을 사업자에게 넘기는 가족회원) 표시는 내가 직접 한다.
    // 표가 아직 없으면 표시 칸 없이 기존 방식 그대로 보여준다.
    const { data: markRows, error: markError } = await supabase
      .from("nrc_seller_marks")
      .select("member_no");
    const canMark = !markError && Array.isArray(markRows);
    const sellers = new Set((markRows || []).map((row) => String(row.member_no)));
    const isSeller = (row) => canMark && sellers.has(String(row.member_no));
    const operators = rows.filter((row) => !isSeller(row));
    const joined = operators.filter((row) => row.has_account).length;
    const verified = operators.filter((row) => row.verified).length;
    const mark = (row) =>
      isSeller(row)
        ? "👪 매출자 (가입 불필요)"
        : row.verified
          ? "✅ 가입 · 수집 확인"
          : row.has_account
            ? "🟡 가입 · 수집 확인 전"
            : "❌ 미가입";
    // 가입한 사람(수집 확인 → 가입)을 맨 위로, 그다음 미가입, 매출자는 맨 아래로 보낸다.
    const rank = (row) =>
      isSeller(row) ? 3 : row.verified ? 0 : row.has_account ? 1 : 2;
    const body = [...rows]
      .sort((a, b) => rank(a) - rank(b) || a.lv - b.lv || String(a.member_no).localeCompare(String(b.member_no)))
      .map(
        (row) =>
          `<tr>${td(`${safe(row.member_name || "")} (${safe(row.member_no)})`)}${td(
            safe(row.rank_name || ""),
          )}${td(mark(row))}${
            canMark
              ? td(
                  `<span data-seller-cell style="display:inline-flex;gap:4px;align-items:center;cursor:pointer;user-select:none;touch-action:none;white-space:nowrap"><input type="checkbox" tabindex="-1" style="pointer-events:none" data-seller="${safe(row.member_no)}"${
                    isSeller(row) ? " checked" : ""
                  }> 매출자</span>`,
                )
              : ""
          }</tr>`,
      )
      .join("");
    const summary = canMark
      ? `사업자 가입 ${joined} / ${operators.length}명 (수집 확인 ${verified}명) · 매출자 ${rows.length - operators.length}명`
      : `가입 ${joined} / 전체 ${rows.length}명 (수집 확인 ${verified}명)`;
    box.innerHTML = `<details class="card" style="margin:8px 0" open><summary><b>팀 가입 현황 · ${summary}</b></summary><div class="help">NRC 계보 기준으로 내 아래 전체입니다. 앱에 가입하고 NRC 수집까지 마치면 마감 값과 현황이 위로 전달됩니다. 같은 사람의 여러 박스는 한 명으로 묶어 보여줍니다.${
      canMark
        ? " 사업을 하지 않고 수당을 사업자에게 넘기는 가족회원은 \"매출자\"로 체크하면 가입 대상에서 빠집니다. 체크칸을 누른 채 위아래로 끌면 여러 명을 한 번에 표시하거나 해제할 수 있습니다. 아래 사업자가 매출자로 표시한 사람은 위 계정 화면에서는 보이지 않습니다."
        : ""
    }</div><button type="button" class="compact" data-tc-copy>가입 안내 문구 복사</button> <span data-tc-copymsg class="help"></span><table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:6px"><thead><tr>${th("사람")}${th("직급")}${th("상태")}${canMark ? th("") : ""}</tr></thead><tbody>${body}</tbody></table></details>`;
  };

  root.onclick = async (event) => {
    const invite = event.target.closest("[data-gather-invite]");
    if (invite) {
      const teamId = invite.dataset.gatherInvite;
      const { data: code, error } = await supabase.rpc("create_gathering_invite", {
        p_team_id: teamId,
      });
      const target = root.querySelector(`[data-gather-code="${CSS.escape(teamId)}"]`);
      if (error) root.querySelector("[data-gather-msg]").textContent = error.message;
      else if (target) target.textContent = ` 초대코드 ${code} (7일간 유효 · 지금 한 번만 보여줍니다)`;
      return;
    }
    if (event.target.closest("[data-tc-copy]")) {
      const text =
        "NRC 사업관리 앱 가입 안내\n" +
        "주소: https://prepaid1215.github.io/nr-manage/v2/frontend/index.html\n" +
        '로그인 화면의 "처음이신가요? 회원가입"에서 본인 회원번호로 가입한 뒤, NRC 데이터 수집까지 한 번 진행해 주세요.\n' +
        "(본인 회원번호로 수집된 자료로 계정 소유를 확인합니다)";
      const message = root.querySelector("[data-tc-copymsg]");
      try {
        await navigator.clipboard.writeText(text);
        message.textContent = "복사했습니다. 카톡 등에 붙여넣으세요.";
      } catch {
        message.textContent = text;
      }
      return;
    }
    const save = event.target.closest("[data-order-save]");
    const remove = event.target.closest("[data-order-delete]");
    if (!save && !remove) return;
    const memberNo = (save || remove).dataset.orderSave || (save || remove).dataset.orderDelete;
    const message =
      (save || remove).closest("[data-tc]")?.querySelector("[data-tc-msg]") ||
      root.querySelector("[data-tc-msg]");
    if (remove) {
      const { error } = await supabase.rpc("delete_closing_order", {
        p_period_id: period.periodId,
        p_member_no: memberNo,
      });
      if (error) message.textContent = error.message;
      else await renderOrders();
      return;
    }
    const read = (kind) =>
      Number(root.querySelector(`[data-order-${kind}="${CSS.escape(memberNo)}"]`)?.value);
    const major = read("major");
    const minor = read("minor");
    if (!(major > 0) || !(minor > 0)) {
      message.textContent = "대·소 목표를 만 단위 숫자(예: 40)로 모두 입력하세요.";
      return;
    }
    const { error } = await supabase.rpc("set_closing_order", {
      p_period_id: period.periodId,
      p_member_no: memberNo,
      p_major: Math.round(major * 10000),
      p_minor: Math.round(minor * 10000),
    });
    if (error) message.textContent = error.message;
    else await renderOrders();
  };

  // 드래그로 한 번에 표시: 체크칸을 누른 채 다른 행 위로 끌면 같은 상태(누른 칸의 반대)로 바뀐다.
  // 손을 떼면 바뀐 사람들을 한 번에 저장한다. (마우스·터치 모두 포인터 이벤트로 처리)
  root._tcAbort?.abort();
  const abort = new AbortController();
  root._tcAbort = abort;
  let drag = null;
  const rowBox = (x, y) =>
    document.elementFromPoint(x, y)?.closest?.("tr")?.querySelector?.("[data-seller]") || null;
  const touch = (box) => {
    if (!drag || !box || drag.boxes.has(box.dataset.seller)) return;
    drag.boxes.set(box.dataset.seller, box);
    box.checked = drag.state;
  };
  root.addEventListener(
    "pointerdown",
    (event) => {
      const cell = event.target.closest("[data-seller-cell]");
      if (!cell || (event.pointerType === "mouse" && event.button !== 0)) return;
      const box = cell.querySelector("[data-seller]");
      event.preventDefault();
      drag = { state: !box.checked, boxes: new Map() };
      touch(box);
    },
    { signal: abort.signal },
  );
  root.addEventListener(
    "pointermove",
    (event) => {
      if (drag) touch(rowBox(event.clientX, event.clientY));
    },
    { signal: abort.signal },
  );
  window.addEventListener(
    "pointerup",
    async () => {
      if (!drag) return;
      const { state, boxes } = drag;
      drag = null;
      const ids = [...boxes.keys()];
      const { data: auth } = await supabase.auth.getUser();
      const ownerId = auth?.user?.id;
      if (!ownerId || !ids.length) return;
      const { error } = state
        ? await supabase
            .from("nrc_seller_marks")
            .upsert(
              ids.map((memberNo) => ({ owner_id: ownerId, member_no: memberNo })),
              { onConflict: "owner_id,member_no", ignoreDuplicates: true },
            )
        : await supabase
            .from("nrc_seller_marks")
            .delete()
            .eq("owner_id", ownerId)
            .in("member_no", ids);
      if (error) boxes.forEach((box) => (box.checked = !state));
      await renderJoin();
    },
    { signal: abort.signal },
  );
  window.addEventListener("pointercancel", () => (drag = null), { signal: abort.signal });

  // 칸 값이 다른 경로로 바뀐 경우(한 명씩 저장)
  root.onchange = async (event) => {
    const box = event.target.closest("[data-seller]");
    if (!box) return;
    const memberNo = box.dataset.seller;
    const { data: auth } = await supabase.auth.getUser();
    const ownerId = auth?.user?.id;
    if (!ownerId) return;
    const { error } = box.checked
      ? await supabase
          .from("nrc_seller_marks")
          .upsert(
            { owner_id: ownerId, member_no: memberNo },
            { onConflict: "owner_id,member_no", ignoreDuplicates: true },
          )
      : await supabase
          .from("nrc_seller_marks")
          .delete()
          .eq("owner_id", ownerId)
          .eq("member_no", memberNo);
    if (error) box.checked = !box.checked;
    await renderJoin();
  };

  await Promise.all([
    renderGatherings(),
    renderMine(),
    renderOrders(),
    renderJoin(),
    renderTeamActivity(),
  ]);
}
