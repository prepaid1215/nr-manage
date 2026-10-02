import { supabase } from "./supabase.js?v=20260829-34";
import {
  attachPerformanceSubtree,
  applyClosingCompletion,
  applyOwnSalesFlow,
  branchBreakdown,
  buildPerformanceModel,
  calculatePerformance,
  cancelClosingCompletion,
  cancelCompletionCascade,
  closingPeriodForDate,
  completionWhenAchieved,
  evaluatePromotion,
  evaluatePromotionPath,
  planClosing,
  planSignature,
  planBalancedClosingTopUp,
  projectClosingCompletion,
  pruneInvalidCompletions,
  salesTopUpForDeficit,
  sortMembersDeepestFirst,
} from "./performance-calculator.js?v=20260908-57";
import { boxTreeHtml } from "./box-tree.js?v=20261002-1";
import {
  addManualLink,
  loadManualLinks,
  removeManualLink,
} from "./genealogy-links.js?v=20260831-1";

const PLAN_TABLE = "nrc_closing_plans";
const MIN_TREE_ZOOM = 0.72;
const LOCAL_PLAN_KEY = "nrc-closing-plan-backup";
const fmt = (value) => Number(value || 0).toLocaleString("ko-KR");
const safe = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
};

export async function performancePage(root) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const initialPeriod = closingPeriodForDate(today);
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>마감 실적 계산기</h2><p class="help">이번 차수에 실제로 마감할 사업자만 선택하고, 각 사업자의 대·소목표를 직접 입력하세요.</p></div><label>기준일<input id="perfDate" type="date" value="${initialPeriod.endDate}"></label></div><p id="perfPeriod" class="connection-status"></p><p id="perfSource" class="help"></p><p id="perfStorage" class="help"></p><div class="closing-target-row"><label>최상위 마감 사업자<select id="topMemberSelect"></select></label><label>대실적 목표 (NV)<input id="topMajor" type="number" min="1" step="1000"></label><label>소실적 목표 (NV)<input id="topMinor" type="number" min="1" step="1000"></label></div><div id="firstRoundTop" class="closing-target-row" hidden><label>1차 현재 대실적 직접 입력<input id="topCurrentMajor" type="number" min="0" step="1"></label><label>1차 현재 소실적 직접 입력<input id="topCurrentMinor" type="number" min="0" step="1"></label></div><details class="closing-member-picker" open><summary>이번 차수 마감 사업자 <b id="closingCount">0명</b></summary><p class="help">체크한 사업자만 별도로 마감합니다. 체크하지 않은 회원은 목표를 만들지 않고 현재 조직실적과 하위 증가분만 상위로 전달합니다.</p><div id="closingOptions" class="closing-member-options"></div><details class="performance-link-manager"><summary>끊긴 계보 수동으로 잇기</summary><p class="help">중간 회원이 수집자료에 보이지 않을 때 상위와 하위 사업자 회원번호를 직접 연결합니다. 같은 회원번호는 한 번만 계산됩니다.</p><form id="perfManualLinkForm" class="inline-form"><input id="perfLinkParent" placeholder="상위 회원번호" required><input id="perfLinkChild" placeholder="하위 사업자 회원번호" required><input id="perfLinkName" placeholder="하위 사업자 이름"><button class="primary compact" type="submit">계보 연결</button></form><div id="perfLinkError" class="error"></div><div id="perfLinkList" class="fav-list"></div></details></details><button id="perfRun" class="primary">현재 실적과 추천 매출 계산</button><p id="perfNotice" class="help"></p><div id="perfError" class="error"></div></section><section id="perfSummary"></section><section id="perfResult"></section>`;
  const $ = (id) => document.getElementById(id);
  let { data, error } = await supabase
    .from("nrc_sync_snapshots")
    .select("payload,collected_at,source_account_id")
    .eq("snapshot_type", "combined")
    .order("collected_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    $("perfError").textContent = error?.message || "수집된 JSON이 없습니다.";
    return;
  }

  let model;
  let rawPayload;
  try {
    rawPayload =
      typeof data.payload === "string"
        ? JSON.parse(data.payload)
        : data.payload;
    model = buildPerformanceModel(rawPayload);
  } catch (parseError) {
    $("perfError").textContent = parseError.message;
    return;
  }
  let collectedPerformance = new Map(
    model.rows.map((row) => [
      String(row.userId),
      { majorNv: Number(row.maxPv || 0), minorNv: Number(row.minPv || 0) },
    ]),
  );
  $("perfSource").textContent =
    `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · 계보도 가장 아래 사업자부터 순서대로 마감합니다.`;

  const { data: auth } = await supabase.auth.getUser().catch(() => ({}));
  const ownerId = auth?.user?.id || null;
  let storage = ownerId ? "supabase" : "local";
  let storageNote = ownerId
    ? ""
    : "로그인 정보를 찾지 못해 이 브라우저에만 저장합니다.";
  let plan = null;
  let lastRun = null;
  let lastSignature = "";
  let items = [];
  let period = initialPeriod;
  let previousPerformance = {};
  let firstRoundPerformance = {};
  let manualLinks = [];
  const snapshotModels = [];
  if (ownerId) {
    const { data: snapshots } = await supabase
      .from("nrc_sync_snapshots")
      .select("payload,collected_at,source_account_id")
      .eq("snapshot_type", "combined")
      .order("collected_at", { ascending: false })
      .limit(100);
    const seenSources = new Set();
    (snapshots || []).forEach((snapshot) => {
      const sourceId = String(snapshot.source_account_id || "");
      if (seenSources.has(sourceId)) return;
      seenSources.add(sourceId);
      try {
        const payload =
          typeof snapshot.payload === "string"
            ? JSON.parse(snapshot.payload)
            : snapshot.payload;
        snapshotModels.push({
          sourceId,
          collectedAt: snapshot.collected_at,
          model: buildPerformanceModel(payload),
        });
      } catch {}
    });
    let changed = true;
    let passes = 0;
    while (changed && passes <= snapshotModels.length) {
      changed = false;
      passes += 1;
      snapshotModels.forEach(({ model: sourceModel }) => {
        const overlaps = [...model.byId.keys()].filter((id) =>
          sourceModel.byId.has(id),
        );
        overlaps.forEach((id) => {
          if (attachPerformanceSubtree(model, sourceModel, id) > 0)
            changed = true;
        });
      });
    }
    manualLinks = await loadManualLinks(ownerId);
    manualLinks.forEach((link) => {
      const childId = String(link.member_id);
      const source =
        snapshotModels.find(({ model: sourceModel }) =>
          sourceModel.byId.has(childId),
        )?.model || (model.byId.has(childId) ? model : null);
      if (source) {
        attachPerformanceSubtree(model, source, childId, link.parent_id);
      } else if (model.byId.has(String(link.parent_id))) {
        const placeholder = buildPerformanceModel({
          rstLst: [
            {
              userId: childId,
              userName: link.member_name,
              ppId: String(link.parent_id),
              manualLink: true,
            },
          ],
        });
        attachPerformanceSubtree(
          model,
          placeholder,
          childId,
          link.parent_id,
        );
      }
    });
    collectedPerformance = new Map(
      model.rows.map((row) => [
        String(row.userId),
        { majorNv: Number(row.maxPv || 0), minorNv: Number(row.minPv || 0) },
      ]),
    );
  }

  const legacyPlan = () => {
    const selected = readJson("nrc-closing-members", [])
      .map(String)
      .filter((id) => model.byId.has(id));
    if (!selected.length) return null;
    const ordered = sortMembersDeepestFirst(model, selected);
    const top = ordered[ordered.length - 1];
    const targets = readJson("nrc-closing-member-targets", {});
    const completions = readJson("nrc-closing-completions", {});
    const topMajorTarget =
      Number(targets[top.userId]?.major) ||
      Number(localStorage.getItem("nrc-performance-major-target")) ||
      400000;
    const topMinorTarget =
      Number(targets[top.userId]?.minor) ||
      Number(localStorage.getItem("nrc-performance-minor-target")) ||
      400000;
    const signature = planSignature(
      top.userId,
      { majorTarget: topMajorTarget, minorTarget: topMinorTarget },
      selected,
    );
    return {
      topMemberId: String(top.userId),
      topMajorTarget,
      topMinorTarget,
      closingMemberIds: selected,
      targetOverrides: {},
      manualPerformance: {},
      completions: Object.fromEntries(
        Object.entries(completions)
          .filter(([id]) => model.byId.has(String(id)))
          .map(([id, value]) => [id, { ...value, signature }]),
      ),
    };
  };

  const defaultPlan = () => ({
    topMemberId: String(model.rows[0].userId),
    topMajorTarget: 400000,
    topMinorTarget: 400000,
    closingMemberIds: [String(model.rows[0].userId)],
    targetOverrides: {},
    manualPerformance: {},
    completions: {},
  });

  const rowToPlan = (row) => ({
    topMemberId: String(row.top_member_id),
    topMajorTarget: Number(row.top_major_target),
    topMinorTarget: Number(row.top_minor_target),
    closingMemberIds: (row.closing_member_ids || []).map(String),
    targetOverrides: row.allocation?.targetOverrides || {},
    manualPerformance: row.allocation?.manualPerformance || {},
    periodId: row.period_id || initialPeriod.periodId,
    completions: row.completions || {},
  });

  const previousPeriodId = () =>
    period.round > 1
      ? `${period.year}-${String(period.month).padStart(2, "0")}-${period.round - 1}`
      : null;

  async function loadPreviousPerformance() {
    previousPerformance = {};
    firstRoundPerformance = {};
    const previousId = previousPeriodId();
    if (!previousId) return;
    let previousRow = null;
    if (storage === "supabase") {
      const { data: row } = await supabase
        .from(PLAN_TABLE)
        .select("allocation")
        .eq("period_id", previousId)
        .eq("top_member_id", plan.topMemberId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      previousRow = row;
    } else {
      previousRow = readJson(`${LOCAL_PLAN_KEY}:${previousId}`, null);
    }
    previousPerformance =
      previousRow?.allocation?.currentPerformance ||
      previousRow?._lastRun?.allocation?.currentPerformance ||
      {};
    if (period.round === 2) {
      firstRoundPerformance = previousPerformance;
    } else if (period.round > 2) {
      const firstId = `${period.year}-${String(period.month).padStart(2, "0")}-1`;
      let firstRow = null;
      if (storage === "supabase") {
        const { data: row } = await supabase
          .from(PLAN_TABLE)
          .select("allocation")
          .eq("period_id", firstId)
          .eq("top_member_id", plan.topMemberId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        firstRow = row;
      } else {
        firstRow = readJson(`${LOCAL_PLAN_KEY}:${firstId}`, null);
      }
      firstRoundPerformance =
        firstRow?.allocation?.currentPerformance ||
        firstRow?._lastRun?.allocation?.currentPerformance ||
        {};
    }
  }

  const renderStorageNote = () => {
    $("perfStorage").textContent =
      storage === "supabase"
        ? "저장 위치: 내 계정(Supabase) · 다른 기기에서도 이어서 볼 수 있습니다."
        : `저장 위치: 이 브라우저만 · ${storageNote}`;
  };

  async function persistPlan() {
    const topCompletion = plan.completions[plan.topMemberId] || null;
    if (storage === "supabase") {
      const row = {
        owner_id: ownerId,
        period_id: period.periodId,
        period_year: period.year,
        period_month: period.month,
        closing_round: period.round,
        top_member_id: plan.topMemberId,
        top_major_target: plan.topMajorTarget,
        top_minor_target: plan.topMinorTarget,
        closing_member_ids: plan.closingMemberIds,
        completions: plan.completions,
        allocation: lastRun?.allocation
          ? { ...lastRun.allocation, targetOverrides: plan.targetOverrides, manualPerformance: plan.manualPerformance }
          : Object.keys(plan.targetOverrides || {}).length
            ? { targetOverrides: plan.targetOverrides, manualPerformance: plan.manualPerformance }
            : null,
        placements: lastRun?.placements || null,
        top_major_nv: lastRun?.topMajorNv ?? null,
        top_minor_nv: lastRun?.topMinorNv ?? null,
        top_completed_nv: lastRun?.topCompletedNv ?? null,
        verified: Boolean(lastRun?.verified),
        status: topCompletion ? "DONE" : "DRAFT",
        completed_at: topCompletion?.completedAt || null,
        snapshot_source_account_id: data.source_account_id || null,
        snapshot_collected_at: data.collected_at || null,
        updated_at: new Date().toISOString(),
      };
      const { error: saveError } = await supabase
        .from(PLAN_TABLE)
        .upsert(row, { onConflict: "owner_id,period_id,top_member_id" });
      if (!saveError) {
        renderStorageNote();
        return true;
      }
      storage = "local";
      storageNote = /does not exist|schema cache|relation/i.test(
        saveError.message,
      )
        ? "Supabase에서 RUN_013_PERFORMANCE_PERIODS.sql을 실행하세요. 기존 데이터는 삭제하지 않았습니다."
        : `Supabase 저장 실패: ${saveError.message} (기존 데이터는 그대로 남아 있습니다)`;
    }
    try {
      localStorage.setItem(
        `${LOCAL_PLAN_KEY}:${period.periodId}`,
        JSON.stringify({ ...plan, _lastRun: lastRun }),
      );
    } catch {}
    renderStorageNote();
    return false;
  }

  if (storage === "supabase") {
    const { data: planRow, error: planError } = await supabase
      .from(PLAN_TABLE)
      .select("*")
      .eq("period_id", initialPeriod.periodId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (planError) {
      storage = "local";
      storageNote = /does not exist|schema cache|relation/i.test(
        planError.message,
      )
        ? "Supabase에서 RUN_013_PERFORMANCE_PERIODS.sql을 실행하면 차수별로 저장됩니다."
        : `Supabase 조회 오류: ${planError.message}`;
    } else if (planRow) {
      plan = rowToPlan(planRow);
    } else {
      const migrated = legacyPlan();
      if (migrated) {
        plan = migrated;
        await persistPlan();
      }
    }
  }
  if (!plan) {
    plan =
      (storage === "local" &&
        (readJson(`${LOCAL_PLAN_KEY}:${initialPeriod.periodId}`, null) ||
          readJson(LOCAL_PLAN_KEY, null))) ||
      legacyPlan() ||
      defaultPlan();
  }
  if (!model.byId.has(String(plan.topMemberId))) plan = defaultPlan();
  plan.closingMemberIds = (plan.closingMemberIds || [])
    .map(String)
    .filter((id) => model.byId.has(id));
  if (!plan.closingMemberIds.includes(plan.topMemberId)) {
    plan.closingMemberIds.push(plan.topMemberId);
  }
  plan.targetOverrides = Object.fromEntries(
    Object.entries(plan.targetOverrides || {}).filter(([id]) =>
      model.byId.has(String(id)),
    ),
  );
  plan.periodId ||= initialPeriod.periodId;
  plan.manualPerformance ||= {};
  await loadPreviousPerformance();
  renderStorageNote();

  const descendantsOf = (topId) => {
    const out = [];
    const stack = [...(model.children.get(String(topId)) || [])];
    while (stack.length) {
      const row = stack.pop();
      out.push(row);
      (model.children.get(String(row.userId)) || []).forEach((child) =>
        stack.push(child),
      );
    }
    return out.sort(
      (left, right) => model.rows.indexOf(left) - model.rows.indexOf(right),
    );
  };

  // "밸런스로 나누기" 미리보기 전용 상태. rootMemberId(어느 라인을 열었는지)별로
  // "적용함"으로 토글해둔 리프 회원 id 집합을 기억해서, 다시 그릴 때 그 사람들의
  // 실적에 실제로 추가 NV를 더한 뒤 전체를 재계산한다 — 배지 문구만 바꾸는 게
  // 아니라 위쪽 상위 라인까지 진짜로 다시 계산되게 하기 위함.
  const balanceOverrides = new Map();
  // 박스마다 켜고 끄는 "수익계좌" 표시. 켜면(ON) 그 사람은 대·소를 각각 독립
  // 채워야 마감(수당 발생)으로 보고, 꺼져 있으면(기본값) 대+소 합계가 목표
  // 합계만 넘으면 통과로 본다 — rootMemberId별로 별도로 기억한다.
  const incomeAccounts = new Map();

  const renderBalancePreview = (rootMemberId) => {
    const topDescendantIds = descendantsOf(plan.topMemberId).map((row) => String(row.userId));
    const subtreeIds = new Set([
      rootMemberId,
      ...descendantsOf(rootMemberId).map((row) => String(row.userId)),
    ]);
    const applied = balanceOverrides.get(rootMemberId) || new Set();
    const incomeMarked = incomeAccounts.get(rootMemberId) || new Set();

    // 화면에서 체크박스를 이것저것 눌러보거나 목표를 여러 번 바꿔 계산하면
    // 실제 model에는 그동안의 마감 완료/예상치(completedClosingNv 등)가 그대로 남아있다.
    // 밸런스 미리보기는 그런 잔여 상태와 무관하게 항상 "수집된 원본 실적"에서
    // 지금까지 적용(토글)한 매출만 반영해서 매번 깨끗하게 다시 계산한다.
    const clonedModel = buildPerformanceModel(rawPayload);
    const addedNvByLeaf = new Map();
    // planClosing이 내부적으로 계산해둔 r.effectiveTotals는 "대·소 각각 독립"
    // 가정(수익계좌 방식)이 이미 섞여 있어서 합계 통과 판정에 쓰면 부풀려진다.
    // 합계 통과 쪽은 항상 이 rawTotalOf(원본 + 지금까지 적용한 delta)로만 판정한다.
    const rawTotalOf = (id, deltaMap) => {
      const row = clonedModel.byId.get(id);
      return (
        Number(row?.ordPv || 0) +
        Number(row?.maxPv || 0) +
        Number(row?.minPv || 0) +
        (deltaMap.get(String(id)) || 0)
      );
    };

    const computeOnce = () => {
      let balancePlan;
      try {
        // 부분 라인만 떼어서 다시 목표를 주면(예: 2893498한테 대·소 각각 40만) 중복으로
        // 80만을 요구하는 셈이 되어버리므로, 반드시 실제 최상위·실제 목표로 전체를 한 번에
        // 계산하고 그 결과에서 이 라인(rootMemberId) 아래 부분만 뽑아서 보여준다.
        balancePlan = planClosing(
          clonedModel,
          plan.topMemberId,
          { majorTarget: plan.topMajorTarget, minorTarget: plan.topMinorTarget },
          [plan.topMemberId, ...topDescendantIds],
          {},
        );
      } catch (balanceError) {
        return { error: balanceError };
      }
      return { balancePlan };
    };

    // "합계 통과"(수익계좌 아님) 구간에서는 부모 하나가 부족분을 전부 떠안는 게
    // 아니라, 본인 계좌 + 직속 하위(들) 사이에 균형 있게 나눠 추천해야 한다
    // (신주영 본인 vs 진순정처럼, 둘이 따로따로 계산되면 서로 안 맞는 추천이
    // 두 개 나온다). manualDelta(적용한 하위의 증가분)까지 반영한 "현재 실제
    // 합계"를 기준으로, 부족한 만큼을 본인/각 하위에 재귀적으로 절반씩 나눈다.
    // 수익계좌로 표시된 사람을 만나면 그 밑은 독립(대·소) 로직이 따로 처리하므로
    // 이 재귀는 더 내려가지 않는다.
    const planCombinedDeficit = (memberId, requiredTotal, deltaMap, out, targetLookup) => {
      const currentTotal = rawTotalOf(memberId, deltaMap);
      const deficit = Math.max(0, requiredTotal - currentTotal);
      if (deficit <= 0) return;
      const allChildren = (clonedModel.children.get(memberId) || []).filter(
        (child) => !incomeMarked.has(String(child.userId)),
      );
      // 이미 자기 목표(라인전체 기준 목표)를 채운 하위는 더 요구하지 않는다 —
      // 그 초과분은 이미 currentTotal에 반영돼 있으니 그대로 두고, 아직
      // 부족한 하위와 본인 사이에서만 나눈다. (신주영2918877/이충언처럼 이미
      // 채운 라인에 또 배지가 뜨는 걸 막기 위함.)
      const neediness = allChildren.filter((child) => {
        const childId = String(child.userId);
        const childTarget = targetLookup.get(childId);
        return childTarget == null || rawTotalOf(childId, deltaMap) < childTarget;
      });
      if (!neediness.length) {
        out.set(memberId, (out.get(memberId) || 0) + deficit);
        return;
      }
      const shareCount = 1 + neediness.length;
      let remaining = deficit;
      const shares = Array.from({ length: shareCount }, (_, i) => {
        const share = i === shareCount - 1 ? remaining : Math.ceil(deficit / shareCount);
        remaining -= share;
        return share;
      });
      if (shares[0] > 0) out.set(memberId, (out.get(memberId) || 0) + shares[0]);
      neediness.forEach((child, idx) => {
        const childId = String(child.userId);
        const childShare = shares[idx + 1];
        if (childShare <= 0) return;
        const childCurrent = rawTotalOf(childId, deltaMap);
        planCombinedDeficit(childId, childCurrent + childShare, deltaMap, out, targetLookup);
      });
    };

    // "합계 통과" 구간의 시작점(= 이 라인 자체이거나, 바로 위가 수익계좌인 지점)에서만
    // 재귀를 걸어서 이중 계산을 막는다 — 부모가 이미 합계 통과 중이면 그 재귀 안에서
    // 자식까지 같이 처리되므로 자식에서 또 걸 필요가 없다.
    const isCombinedSegmentRoot = (memberId) => {
      if (incomeMarked.has(memberId)) return false;
      if (memberId === rootMemberId) return true;
      const row = clonedModel.byId.get(memberId);
      const parentId = String(row?.ppId ?? "");
      return incomeMarked.has(parentId) || !subtreeIds.has(parentId);
    };

    // 1차 계산: 토글 대상마다 필요한 추가 NV(추천 매출량)를 먼저 알아낸다(적용 전 상태 기준).
    const first = computeOnce();
    if (first.error) return { error: first.error };
    const emptyDelta = new Map();
    const firstTargetLookup = new Map();
    first.balancePlan.steps.forEach((step) => {
      if (!step.skipped) {
        firstTargetLookup.set(
          step.memberId,
          step.allocation.majorTarget + step.allocation.minorTarget,
        );
      }
    });
    first.balancePlan.steps
      .filter((step) => !step.skipped && subtreeIds.has(step.memberId))
      .forEach((step) => {
        const isLeaf = !(clonedModel.children.get(step.memberId) || []).length;
        if (isLeaf || incomeMarked.has(step.memberId) || !isCombinedSegmentRoot(step.memberId)) {
          if (!isLeaf) return; // 수익계좌·비-세그먼트루트는 아래에서 따로 처리
          if (incomeMarked.has(String(clonedModel.byId.get(step.memberId)?.ppId ?? ""))) {
            // 부모가 수익계좌면 이 리프는 예전처럼 독립(대·소 합산) 기준.
            const row = clonedModel.byId.get(step.memberId);
            const combinedTarget = step.allocation.majorTarget + step.allocation.minorTarget;
            const ownNv = Number(row?.ordPv || 0);
            if (ownNv < combinedTarget) {
              addedNvByLeaf.set(step.memberId, salesTopUpForDeficit(combinedTarget - ownNv).addedNv);
            }
            return;
          }
          return; // 합계 통과 세그먼트에 속한 리프는 세그먼트 루트의 재귀에서 계산됨
        }
        // 이 노드가 합계 통과 세그먼트의 시작점이다 — 여기서부터 재귀로 본인/하위에 나눈다.
        const combinedTarget = step.allocation.majorTarget + step.allocation.minorTarget;
        planCombinedDeficit(step.memberId, combinedTarget, emptyDelta, addedNvByLeaf, firstTargetLookup);
      });
    // 수익계좌로 표시된 사람 본인의 부족분(기존 독립 로직)도 1차에 포함한다.
    first.balancePlan.steps
      .filter((step) => !step.skipped && subtreeIds.has(step.memberId) && incomeMarked.has(step.memberId))
      .forEach((step) => {
        const r = step.result;
        if (r.achieved) return;
        const ownIndex = r.ownContributionIndex;
        const place = r.placements[ownIndex];
        if (place?.kind !== "self") return;
        const deficit = r.deficits[ownIndex];
        if (deficit > 0) addedNvByLeaf.set(step.memberId, salesTopUpForDeficit(deficit).addedNv);
      });

    // 토글로 "적용"한 사람들의 실적에 실제로 추가 NV를 더한 뒤, 그 상태로 다시 계산한다.
    // 동시에 ppId를 타고 올라가며 상위 라인전체/총에도 같은 만큼 반영되도록
    // manualDelta에 누적한다. (planClosing이 내부적으로 쓰는 completedClosingNv는
    // "본인이 직접 매출을 더 넣었다"는 별개의 가상 계산이 섞여 있어서 쓰지 않고,
    // 여기서는 실제로 적용한 값만 순수하게 위로 더한다.)
    const manualDelta = new Map();
    applied.forEach((memberId) => {
      const extra = addedNvByLeaf.get(memberId);
      const row = clonedModel.byId.get(memberId);
      if (!row || !extra) return;
      row.ordPv = Number(row.ordPv || 0) + extra;
      let current = row;
      const visited = new Set([String(row.userId)]);
      while (current?.ppId && !visited.has(String(current.ppId))) {
        const parentId = String(current.ppId);
        visited.add(parentId);
        manualDelta.set(parentId, (manualDelta.get(parentId) || 0) + extra);
        current = clonedModel.byId.get(parentId);
      }
    });
    const second = applied.size ? computeOnce() : first;
    if (second.error) return { error: second.error };
    const balancePlan = second.balancePlan;

    // 적용 후 남은 부족분을 같은 방식(본인/하위 균형 분배)으로 다시 계산해서
    // 배지에 쓴다 — 1차 때와 똑같은 세그먼트 루트에서 다시 재귀를 돌리되,
    // 이번엔 manualDelta(적용된 값)를 반영한 "현재 실제" 기준으로 본다.
    const secondTargetLookup = new Map();
    balancePlan.steps.forEach((step) => {
      if (!step.skipped) {
        secondTargetLookup.set(
          step.memberId,
          step.allocation.majorTarget + step.allocation.minorTarget,
        );
      }
    });
    const remainingDeficit = new Map();
    balancePlan.steps
      .filter((step) => !step.skipped && subtreeIds.has(step.memberId))
      .forEach((step) => {
        const isLeaf = !(clonedModel.children.get(step.memberId) || []).length;
        if (isLeaf) return;
        if (!isCombinedSegmentRoot(step.memberId)) return;
        const combinedTarget = step.allocation.majorTarget + step.allocation.minorTarget;
        planCombinedDeficit(step.memberId, combinedTarget, manualDelta, remainingDeficit, secondTargetLookup);
      });

    const badges = {};
    const notes = {};
    const incomeToggleIds = new Set();
    balancePlan.steps
      .filter((step) => !step.skipped && subtreeIds.has(step.memberId))
      .forEach((step) => {
        const isLeaf = !(clonedModel.children.get(step.memberId) || []).length;
        if (!isLeaf) incomeToggleIds.add(step.memberId);
        const parentId = String(clonedModel.byId.get(step.memberId)?.ppId ?? "");
        const parentIsIncome = incomeMarked.has(parentId);
        if (isLeaf) {
          const row = clonedModel.byId.get(step.memberId);
          const ownNv = Number(row?.ordPv || 0);
          const isApplied = applied.has(step.memberId);
          if (parentIsIncome) {
            // 부모가 수익계좌로 표시됨 — 이 리프는 기존처럼 대·소 합친 독립 목표로 본다.
            const combinedTarget = step.allocation.majorTarget + step.allocation.minorTarget;
            const achieved = ownNv >= combinedTarget;
            notes[step.memberId] =
              `밸런스 배분 · 목표 ${fmt(combinedTarget)} (대·소 구분 없음) · ${achieved ? "채움" : "부족"}`;
            if (!achieved) {
              const topUpEntry = salesTopUpForDeficit(combinedTarget - ownNv);
              badges[step.memberId] = {
                applied: false,
                text: `매출 ${fmt(topUpEntry.salesWon)}원 넣으면 → ${fmt(ownNv + topUpEntry.addedNv)} NV (누르면 적용)`,
              };
            } else if (isApplied) {
              badges[step.memberId] = {
                applied: true,
                text: `✅ 적용함 · ${fmt(ownNv)} NV (누르면 되돌리기)`,
              };
            }
            return;
          }
          // "합계 통과" 세그먼트에 속한 리프 — 세그먼트 루트에서 재귀로 나눠준
          // remainingDeficit 몫만큼만 이 사람 배지로 보여준다(상위와 중복 계산 없음).
          const myDeficit = remainingDeficit.get(step.memberId) || 0;
          notes[step.memberId] = `밸런스 배분(합계 통과 분담) · 본인 ${fmt(ownNv)} NV`;
          if (myDeficit > 0 && !isApplied) {
            const topUpEntry = salesTopUpForDeficit(myDeficit);
            badges[step.memberId] = {
              applied: false,
              text: `매출 ${fmt(topUpEntry.salesWon)}원 넣으면 → ${fmt(ownNv + topUpEntry.addedNv)} NV (누르면 적용)`,
            };
          } else if (isApplied) {
            badges[step.memberId] = {
              applied: true,
              text: `✅ 적용함 · ${fmt(ownNv)} NV (누르면 되돌리기)`,
            };
          }
          return;
        }
        const r = step.result;
        const p = step.projection;
        const actualMajor = r.effectiveTotals[r.majorIndex];
        const actualMinor = r.effectiveTotals[r.minorIndex];
        const isIncomeAccount = incomeMarked.has(step.memberId);

        if (!isIncomeAccount) {
          // 수익계좌로 표시 안 한 사람(기본값)은 그냥 통과 라인으로 본다 —
          // 대·소를 각각 채울 필요 없이 합계가 목표 합계만 넘으면 된다.
          // (이충언+신주영 본인처럼, 대실적 쪽이 남아돌면 그걸로 소실적
          // 부족분까지 대신 채워지는 걸로 취급.)
          const combinedTarget = step.allocation.majorTarget + step.allocation.minorTarget;
          const combinedActual = rawTotalOf(step.memberId, manualDelta);
          const combinedAchieved = combinedActual >= combinedTarget;
          notes[step.memberId] =
            `밸런스 배분(합계 통과) · 목표 ${fmt(combinedTarget)} · ${combinedAchieved ? "채움" : "부족"}`;
          // planClosing이 내부적으로 "대·소 각각" 기준으로 완료값을 적용해뒀을 수
          // 있으니, 합계 기준 판정과 어긋나면 실제 값(actualMajor/actualMinor)으로
          // 다시 맞춰서 상위 라인전체·총에도 올바르게 반영되게 한다.
          const row = clonedModel.byId.get(step.memberId);
          if (Number(row?.completedClosingNv) > 0) {
            cancelClosingCompletion(clonedModel, step.memberId);
          }
          if (combinedAchieved) {
            // 대·소 어느 쪽에 얼마씩인지는 합계 통과 모드에서 의미가 없으므로
            // (raw 합계만 상위로 정확히 올라가면 되므로) 전부 majorNv 한쪽에 담는다.
            applyClosingCompletion(clonedModel, step.memberId, {
              majorNv: combinedActual,
              minorNv: 0,
              completedNv: combinedActual,
            });
          }
          const currentSplitText = `현재 합계 ${fmt(combinedActual)}`;
          const isApplied = applied.has(step.memberId);
          // 이 사람 본인 몫만(하위와 균형 분배된 뒤 남은 몫) 배지로 보여준다 —
          // remainingDeficit이 없으면(=재귀에서 하위가 이미 다 커버) 배지 없음.
          const myShare = remainingDeficit.get(step.memberId) || 0;
          if (myShare > 0 && !isApplied) {
            const topUpEntry = salesTopUpForDeficit(myShare);
            const ownNv = Number(row?.ordPv || 0);
            badges[step.memberId] = {
              applied: false,
              text: `${currentSplitText} · 본인 매출 ${fmt(topUpEntry.salesWon)}원 넣으면 → 합계 ${fmt(combinedActual + topUpEntry.addedNv)} NV (누르면 적용)`,
            };
          } else {
            badges[step.memberId] = {
              applied: combinedAchieved || isApplied,
              text: isApplied
                ? `✅ ${currentSplitText} · 적용함 (누르면 되돌리기)`
                : `${currentSplitText} · 채움(합계 통과)`,
            };
          }
          return;
        }

        // 수익계좌로 표시한 사람은 대·소를 각각 독립적으로 채워야 한다(기존 방식).
        const achieved = r.achieved
          ? "채움"
          : p.feasible === false
            ? "배치 불가"
            : "부족";
        notes[step.memberId] =
          `밸런스 배분(수익계좌) · 대${fmt(step.allocation.majorTarget)}/소${fmt(step.allocation.minorTarget)} · ${achieved}`;
        const currentSplitText = `현재 대${fmt(actualMajor)}/소${fmt(actualMinor)}`;
        // 본인 쪽 라인이 부족하면(하위를 아무리 올려도 안 채워지는 라인) "본인이
        // 직접 넣으면" 문구를 덧붙인다 — 김정경처럼 하위(김문겸)는 이미 채웠는데
        // 본인 소실적만 부족한 경우가 여기 해당한다.
        const ownIndex = r.ownContributionIndex;
        const place = r.placements[ownIndex];
        const isApplied = applied.has(step.memberId);
        if (place?.kind === "self" && r.deficits[ownIndex] > 0 && !isApplied) {
          const ownNv = Number(clonedModel.byId.get(step.memberId)?.ordPv || 0);
          const topUpEntry = salesTopUpForDeficit(r.deficits[ownIndex]);
          badges[step.memberId] = {
            applied: false,
            text: `${currentSplitText} · 본인 매출 ${fmt(topUpEntry.salesWon)}원 넣으면 → ${fmt(ownNv + topUpEntry.addedNv)} NV (누르면 적용)`,
          };
        } else {
          badges[step.memberId] = {
            applied: r.achieved || isApplied,
            text: isApplied
              ? `✅ ${currentSplitText} · 적용함 (누르면 되돌리기)`
              : `${currentSplitText} · ${achieved}`,
          };
        }
      });

    return { clonedModel, badges, notes, manualDelta, incomeToggleIds, incomeMarked };
  };

  const renderBalancePreviewInto = (rootMemberId) => {
    const output = document.querySelector(
      `[data-balance-output="${CSS.escape(rootMemberId)}"]`,
    );
    if (!output) return;
    const result = renderBalancePreview(rootMemberId);
    if (result.error) {
      output.innerHTML = `<div class="error">${safe(result.error.message)}</div>`;
      return;
    }
    output.innerHTML = `<div class="box-tree compact">${boxTreeHtml(result.clonedModel, rootMemberId, {
      depth: 10,
      badges: result.badges,
      notes: result.notes,
      hideDate: true,
      clickable: false,
      incomeToggleIds: result.incomeToggleIds,
      incomeMarked: result.incomeMarked,
      // 여기(미리보기)는 planClosing이 "본인이 직접 매출을 더 넣었다고 가정"하며
      // 내부적으로 채워둔 completedClosingNv를 보여주면 안 된다 — 실제로 일어나지
      // 않은 가상의 값이라 헷갈린다. 원본(본인+대실적+소실적)에 "적용"으로 토글한
      // 하위의 추가분(manualDelta)만 더해서, 실제로 그 매출을 넣었다면 상위
      // 라인전체/총이 얼마가 될지 보여준다.
      totalOf: (row) =>
        Number(row?.ordPv || 0) +
        Number(row?.maxPv || 0) +
        Number(row?.minPv || 0) +
        (result.manualDelta.get(String(row?.userId)) || 0),
    })}</div><small class="help">실제로 저장/마감되는 게 아니라 미리보기입니다. 초록 배지를 눌러 "적용"하면 그 사람 실적뿐 아니라 위쪽 라인전체·총에도 같은 만큼 반영됩니다 (진짜 매출 입력이나 저장은 아닙니다).</small>`;
  };

  const renderControls = () => {
    $("topMemberSelect").innerHTML = model.rows
      .map(
        (row) =>
          `<option value="${safe(row.userId)}" ${String(row.userId) === plan.topMemberId ? "selected" : ""}>${safe(row.userName)} (${safe(row.userId)})</option>`,
      )
      .join("");
    $("topMajor").value = plan.topMajorTarget;
    $("topMinor").value = plan.topMinorTarget;
    $("firstRoundTop").hidden = true;
    const topCollected = collectedPerformance.get(plan.topMemberId) || {};
    const topManual = plan.manualPerformance[plan.topMemberId] || {};
    $("topCurrentMajor").value = topManual.majorNv ?? topCollected.majorNv ?? 0;
    $("topCurrentMinor").value = topManual.minorNv ?? topCollected.minorNv ?? 0;
    const availableAt = new Date(`${period.endDate}T00:00:00`);
    availableAt.setDate(availableAt.getDate() + 1);
    const collectedAt = new Date(data.collected_at);
    const sourceState =
      collectedAt >= availableAt
        ? "마감일 다음 날 이후 수집 자료를 자동으로 불러왔습니다."
        : `${period.endDate} 마감 다음 날 수집 자료가 아직 없어 최신 자료를 미리보기로 표시합니다.`;
    $("perfPeriod").textContent = `${period.year}년 ${period.month}월 ${period.round}차 · ${period.startDate} ~ ${period.endDate} · ${sourceState}`;
    renderClosers();
  };

  const collapsedCloserBranches = new Set();
  const renderClosers = () => {
    const top = model.byId.get(String(plan.topMemberId));
    const container = $("closingOptions");
    container.classList.add("closing-genealogy-picker");
    $("closingCount").textContent =
      `${plan.closingMemberIds.filter((id) => id !== plan.topMemberId).length}명`;
    if (!top) {
      container.innerHTML = '<p class="help">표시할 계보가 없습니다.</p>';
      return;
    }
    const nodeHtml = (row, level, path) => {
      const id = String(row.userId);
      if (path.has(id) || level >= 10) return "";
      const nextPath = new Set(path);
      nextPath.add(id);
      const isTop = id === String(plan.topMemberId);
      const children = (model.children.get(id) || []).filter(
        (child) => !nextPath.has(String(child.userId)),
      );
      const hasChildren = level < 9 && children.length > 0;
      const collapsed = collapsedCloserBranches.has(id);
      const checked = isTop || plan.closingMemberIds.includes(id);
      const targets = plan.targetOverrides[id] || {};
      const collected = collectedPerformance.get(id) || {};
      const manual = plan.manualPerformance[id] || {};
      const actualInputs =
        false
          ? `<label>1차 현재 대실적<input data-member-current-major="${safe(id)}" type="number" min="0" step="1" value="${manual.majorNv ?? collected.majorNv ?? 0}"></label><label>1차 현재 소실적<input data-member-current-minor="${safe(id)}" type="number" min="0" step="1" value="${manual.minorNv ?? collected.minorNv ?? 0}"></label>`
          : "";
      const targetInputs = isTop
        ? ""
        : `<div class="closing-member-targets" ${checked ? "" : "hidden"}><label>대 목표 NV<input data-member-major="${safe(id)}" type="number" min="1" step="1000" value="${targets.majorTarget ?? ""}" placeholder="직접 입력"></label><label>소 목표 NV<input data-member-minor="${safe(id)}" type="number" min="1" step="1000" value="${targets.minorTarget ?? ""}" placeholder="직접 입력"></label>${actualInputs}</div>`;
      const toggle = hasChildren
        ? `<button class="closing-tree-toggle" data-closing-tree-toggle="${safe(id)}" type="button" aria-label="${collapsed ? "하위 계보 펼치기" : "하위 계보 접기"}">${collapsed ? "+" : "−"}</button>`
        : '<span class="closing-tree-spacer"></span>';
      const checkbox = isTop
        ? '<input type="checkbox" checked disabled>'
        : `<input data-closing-enabled type="checkbox" value="${safe(id)}" ${checked ? "checked" : ""}>`;
      const childrenHtml = hasChildren
        ? `<div class="closing-tree-children" data-closing-tree-children="${safe(id)}" ${collapsed ? "hidden" : ""}>${children.map((child) => nodeHtml(child, level + 1, nextPath)).join("")}</div>`
        : "";
      return `<div class="closing-selector-node" style="--closing-depth:${level}"><div class="closing-selector-row">${toggle}<article class="closing-member-setting"><label class="check">${checkbox}<span>${safe(row.userName)} <small>(${safe(id)}) · ${safe(row.rankName || "회원")}${isTop ? " · 최상위" : ""}</small></span></label>${targetInputs}</article></div>${childrenHtml}</div>`;
    };
    container.innerHTML = nodeHtml(top, 0, new Set());
  };

  const renderManualLinks = () => {
    $("perfLinkList").innerHTML = manualLinks.length
      ? manualLinks
          .map(
            (link) =>
              `<span>${safe(link.member_name || link.member_id)} (${safe(link.member_id)}) → 상위 ${safe(link.parent_id)} <button type="button" data-remove-perf-link="${safe(link.id)}">×</button></span>`,
          )
          .join("")
      : '<small class="help">수동으로 연결한 계보가 없습니다.</small>';
  };

  const lineHtml = (item, index) => {
    const { node, result, projection } = item;
    const line = node.lines[index];
    const isMajor = index === result.majorIndex;
    const branch = result.branches[index];
    const subMember = result.subMembers[index];
    const topUp = projection.topUps[index];
    const placement = result.placements[index];
    const deficit = result.deficits[index];
    const downstreamItem = subMember
      ? items.find((candidate) => candidate.node.memberId === String(subMember.userId))
      : null;
    const downstreamCompletion =
      downstreamItem?.completion || downstreamItem?.projection || null;
    const balanced =
      deficit > 0 && Number(downstreamCompletion?.completedNv || 0) > 0
        ? planBalancedClosingTopUp(
            model,
            subMember.userId,
            deficit,
            downstreamCompletion,
          )
        : null;
    let role;
    if (!subMember) {
      role =
        index === result.ownContributionIndex
          ? "하위 회원이 없어 본인 매출로 채우는 라인"
          : "하위 회원이 없는 라인";
    } else if (line.childAllocation) {
      const closer = model.byId.get(line.childAllocation.memberId);
      const childDone = Boolean(plan.completions[line.childAllocation.memberId]);
      const targetKind = line.childAllocation.overridden ? "직접 입력" : "자동";
      role = branch.completed
        ? `하위 마감 ${safe(closer?.userName || "")} ${childDone ? "완료값" : "예상 완료값"} ${fmt(branch.total)} NV 반영`
        : `하위 마감 ${safe(closer?.userName || "")} 진행 예정 (${targetKind} 목표 대 ${fmt(line.childAllocation.majorTarget)} / 소 ${fmt(line.childAllocation.minorTarget)})`;
    } else {
      role = "현재 조직실적 · 비마감 중간 회원은 별도 목표 없이 그대로 전달";
    }
    const ownNote =
      index === result.ownContributionIndex && result.minorOwnContribution > 0
        ? `<small>본인 매출 ${fmt(result.minorOwnContribution)} NV가 이 라인에 합산됩니다.</small>`
        : index === result.inheritedOwnIndex && result.inheritedOwnNv > 0
          ? `<small>상위 ${safe(model.byId.get(result.inheritedOwnFromMemberId)?.userName || "")} 본인매출 ${fmt(result.inheritedOwnNv)} NV가 이 작은 라인에 합산됩니다.</small>`
          : result.transferredOwnNv > 0 && index === result.ownContributionIndex
            ? `<small>본인매출 ${fmt(result.transferredOwnNv)} NV는 아래 마감자의 작은 라인으로 전달되어 여기서는 중복 합산하지 않습니다.</small>`
            : "";
    const balancedSaleLine = balanced
      ? `<span class="sale-hint"><b>${safe(subMember.userName)} ${isMajor ? "대실적" : "소실적"} 라인 ${fmt(deficit)} NV 부족</b></span><span class="sale-hint">균형 목표 · 대실적 ${fmt(balanced.balancedTargetNv)} / 소실적 ${fmt(balanced.balancedTargetNv)} NV</span><small>현재 ${safe(subMember.userName)} 실적 · 대 ${fmt(balanced.currentMajorNv)} / 소 ${fmt(balanced.currentMinorNv)}</small>${balanced.projection.topUps
          .map((nestedTopUp, nestedIndex) => {
            if (nestedTopUp.salesWon <= 0) return "";
            const nestedPlacement = balanced.result.placements[nestedIndex];
            const side =
              nestedIndex === balanced.result.majorIndex ? "대실적" : "소실적";
            return `<span class="sale-hint">${side} ${fmt(balanced.result.deficits[nestedIndex])} NV 부족 → ${safe(nestedPlacement.target?.userName || "-")} (${safe(nestedPlacement.target?.userId || "-")})에 <b>${fmt(nestedTopUp.salesWon)}원</b> 입력 (+${fmt(nestedTopUp.addedNv)} NV)</span>`;
          })
          .join("")}<small>표시된 금액을 실제 매출에 입력한 뒤 다시 수집해 주세요.</small>`
      : "";
    const saleLine =
      balancedSaleLine ||
      (topUp.salesWon > 0
        ? `<span class="sale-hint">매출 넣을 곳: ${safe(placement.target?.userName || "-")} (${safe(placement.target?.userId || "-")}) · ${fmt(topUp.salesWon)}원 → +${fmt(topUp.addedNv)} NV</span>`
        : deficit > 0
          ? `<span class="sale-hint">${isMajor ? "대실적" : "소실적"} 라인 ${fmt(deficit)} NV 부족 · 매출을 넣을 수 있는 하위 코드를 확인하세요.</span>`
          : `<span>추가 매출이 필요 없습니다.</span>`);
    const balanceButton =
      deficit > 0 && subMember && !balanced
        ? `<button type="button" class="compact" data-balance-preview="${safe(subMember.userId)}" data-balance-target="${line.lineTarget}">밸런스로 나누기</button><div class="balance-output" data-balance-output="${safe(subMember.userId)}"></div>`
        : "";
    return `<article class="closing-line"><b>서브${index + 1} · ${isMajor ? "대실적" : "소실적"}</b><small>${role}</small>${ownNote}<small>지금 ${fmt(result.effectiveTotals[index])} NV · 라인 목표 ${fmt(line.lineTarget)} · ${deficit > 0 ? `${fmt(deficit)} NV 부족` : "목표를 채웠습니다"}</small>${saleLine}${balanceButton}</article>`;
  };

  const treeHtml = (item) => {
    const { node, result, projection } = item;
    const badges = {};
    const notes = {};
    result.placements.forEach((placement, index) => {
      const topUp = projection.topUps[index];
      if (!placement.target || !topUp || topUp.salesWon <= 0) return;
      const id = String(placement.target.userId);
      badges[id] =
        `매출 ${fmt(topUp.salesWon)}원 → +${fmt(topUp.addedNv)} NV${placement.kind === "self" ? " (본인 코드)" : ""}`;
    });
    result.subMembers.forEach((subMember, index) => {
      if (!subMember) return;
      const side = index === result.majorIndex ? "대실적" : "소실적";
      const deficit = result.deficits[index];
      notes[String(subMember.userId)] =
        `서브${index + 1} · ${side} · 라인 ${fmt(result.effectiveTotals[index])} / 목표 ${fmt(node.lines[index].lineTarget)}${deficit > 0 ? ` · ${fmt(deficit)} 부족` : " · 채움"}`;
    });
    const ownIndex = result.ownContributionIndex;
    if (result.minorOwnContribution > 0) {
      notes[node.memberId] =
        `본인 매출 ${fmt(result.minorOwnContribution)} NV는 서브${ownIndex + 1} 라인에 합산`;
    }
    return `<details class="closing-tree"${item.canComplete ? " open" : ""}><summary>계보도로 확인하기</summary><div class="box-tree compact">${boxTreeHtml(model, node.memberId, {
      depth: 10,
      badges,
      notes,
      hideDate: true,
      clickable: false,
      totalOf: (row) => branchBreakdown(row).total,
    })}</div></details>`;
  };

  const fitTrees = () => {
    const boxes = [
      ...$("perfResult").querySelectorAll(".closing-tree[open] .box-tree"),
    ];
    const pass = (round) => {
      boxes.forEach((box) => {
        const list = box.firstElementChild;
        if (!list || !box.clientWidth) return;
        if (round === 0) list.style.zoom = 1;
        const available = box.clientWidth - 10;
        const overflow = box.scrollWidth - box.clientWidth;
        if (round === 0) {
          const needed = list.scrollWidth;
          if (needed > available)
            list.style.zoom = Math.max(MIN_TREE_ZOOM, available / needed);
        } else if (overflow > 1) {
          const current = Number(list.style.zoom) || 1;
          list.style.zoom = Math.max(
            MIN_TREE_ZOOM,
            current * (available / (available + overflow)),
          );
        }
        box.scrollLeft = Math.max(0, (box.scrollWidth - box.clientWidth) / 2);
      });
      if (round === 0) requestAnimationFrame(() => pass(1));
    };
    pass(0);
  };

  const stepHtml = (item, order, total) => {
    const member = model.byId.get(item.node.memberId);
    const title = `${order}/${total} · ${safe(member?.userName || "이름 없음")} <small>(${safe(item.node.memberId)})</small>`;
    if (item.skipped) {
      return `<section class="card closing-step"><div class="section-head"><h2>${title}</h2><b>추가 마감 불필요</b></div><p class="help">위에서 내려온 목표가 이미 라인 실적으로 채워져 추가 마감이 필요 없습니다.</p></section>`;
    }
    const { node, result, projection, completion } = item;
    const state = completion
      ? "완료"
      : item.canComplete
        ? "지금 마감할 차례"
        : "앞 순서 완료 후 진행";
    const warn = result.warnings.length
      ? `<p class="error">${result.warnings.map(safe).join(" ")}</p>`
      : "";
    const button = completion
      ? `<button class="secondary" data-cancel-closing="${safe(node.memberId)}" type="button">마감 취소</button>`
      : `<button class="primary" data-complete-closing="${safe(node.memberId)}" type="button" ${item.canComplete && projection.feasible !== false ? "" : "disabled"}>${projection.feasible === false ? "마감 불가" : item.canComplete ? "마감 완료로 표시" : "앞 순서부터 완료하세요"}</button>`;
    const final = completion
      ? `<p><b>확정 마감</b> · 대 ${fmt(completion.majorNv)} / 소 ${fmt(completion.minorNv)} → 상위 라인에 <b>${fmt(completion.completedNv)} NV</b> 반영</p>`
      : `<p><b>예상 마감</b> · 대 ${fmt(projection.majorNv)} / 소 ${fmt(projection.minorNv)} → 상위 라인에 <b>${fmt(projection.completedNv)} NV</b> 반영 예정</p>`;
    const targetBox = `<p class="help">사용자 입력 목표 · 대 ${fmt(node.majorTarget)} / 소 ${fmt(node.minorTarget)}${completion ? " · 마감을 취소해야 변경할 수 있습니다" : ""}</p>`;
    return `<section class="card closing-step"><div class="section-head"><h2>${title}</h2><b>${state}</b></div>${targetBox}<div class="closing-lines">${lineHtml(item, 0)}${lineHtml(item, 1)}</div>${treeHtml(item)}${final}${warn}${button}</section>`;
  };

  const runPlan = () => {
    $("perfError").textContent = "";
    plan.topMemberId = $("topMemberSelect").value;
    plan.topMajorTarget = Number($("topMajor").value);
    plan.topMinorTarget = Number($("topMinor").value);
    plan.closingMemberIds = [
      ...$("closingOptions").querySelectorAll("[data-closing-enabled]:checked"),
    ].map((input) => input.value);
    if (!plan.closingMemberIds.includes(plan.topMemberId)) {
      plan.closingMemberIds.push(plan.topMemberId);
    }
    plan.targetOverrides = Object.fromEntries(
      plan.closingMemberIds
        .filter((id) => id !== plan.topMemberId)
        .map((id) => {
          const major = Number(
            $("closingOptions").querySelector(`[data-member-major="${CSS.escape(id)}"]`)?.value,
          );
          const minor = Number(
            $("closingOptions").querySelector(`[data-member-minor="${CSS.escape(id)}"]`)?.value,
          );
          return [id, { majorTarget: major, minorTarget: minor }];
        }),
    );
    plan.manualPerformance = {};
    model.rows.forEach((row) => {
      const id = String(row.userId);
      const collected = collectedPerformance.get(id) || {};
      row.maxPv = Number(collected.majorNv || 0);
      row.minPv = Number(collected.minorNv || 0);
      const manual = plan.manualPerformance[id];
      if (manual) {
        row.maxPv = Number(manual.majorNv || 0);
        row.minPv = Number(manual.minorNv || 0);
      }
    });
    lastSignature = planSignature(
      plan.topMemberId,
      { majorTarget: plan.topMajorTarget, minorTarget: plan.topMinorTarget },
      plan.closingMemberIds,
      plan.targetOverrides,
      plan.manualPerformance,
    );
    const validCompletions = pruneInvalidCompletions(
      plan.completions,
      lastSignature,
    );
    const invalidatedCount =
      Object.keys(plan.completions).length -
      Object.keys(validCompletions).length;
    plan.completions = validCompletions;
    $("perfNotice").textContent = invalidatedCount
      ? `최상위 사업자·목표·마감 사업자 조건이 바뀌어 이전 완료 상태 ${invalidatedCount}건을 초기화하고 다시 계산했습니다.`
      : "";
    try {
      model.rows.forEach((row) => {
        delete row.completedClosingMajorNv;
        delete row.completedClosingMinorNv;
        delete row.completedClosingNv;
        delete row.completedClosingPreviousTotal;
        delete row.closingDescendantDeltaNv;
      });
      const depthFromTop = (row) => {
        let depth = 0;
        let current = row;
        const visited = new Set();
        while (
          current &&
          String(current.userId) !== plan.topMemberId &&
          !visited.has(String(current.userId))
        ) {
          visited.add(String(current.userId));
          current = model.byId.get(String(current.ppId || ""));
          depth += 1;
        }
        return depth;
      };
      const nodes = sortMembersDeepestFirst(model, plan.closingMemberIds).map(
        (row) => {
          const id = String(row.userId);
          const targets =
            id === plan.topMemberId
              ? {
                  majorTarget: plan.topMajorTarget,
                  minorTarget: plan.topMinorTarget,
                }
              : plan.targetOverrides[id];
          if (
            !targets ||
            !Number.isFinite(targets.majorTarget) ||
            !Number.isFinite(targets.minorTarget) ||
            targets.majorTarget <= 0 ||
            targets.minorTarget <= 0
          ) {
            throw new Error(`${row.userName || id}의 대·소목표를 모두 직접 입력하세요.`);
          }
          return {
            memberId: id,
            depth: depthFromTop(row),
            majorTarget: targets.majorTarget,
            minorTarget: targets.minorTarget,
            lines: [{}, {}],
          };
        },
      );
      const selectedCloserIds = new Set(nodes.map((node) => node.memberId));
      const inheritedOwnNv = new Map();
      const transferredOwnIds = new Set();
      const nearestSelectedCloser = (start) => {
        const queue = start ? [start] : [];
        const visited = new Set();
        while (queue.length) {
          const row = queue.shift();
          const id = String(row.userId);
          if (visited.has(id)) continue;
          visited.add(id);
          if (selectedCloserIds.has(id)) return id;
          (model.children.get(id) || []).forEach((child) => queue.push(child));
        }
        return null;
      };
      nodes.forEach((node) => {
        const row = model.byId.get(node.memberId);
        const ownNv = Math.max(0, Number(row?.ordPv || 0));
        if (ownNv <= 0) return;
        const base = calculatePerformance(model, node.memberId, {
          majorTarget: node.majorTarget,
          minorTarget: node.minorTarget,
        });
        const receivingCloserId = nearestSelectedCloser(
          base.subMembers[base.ownContributionIndex],
        );
        if (!receivingCloserId || receivingCloserId === node.memberId) return;
        inheritedOwnNv.set(receivingCloserId, {
          amount: Number(inheritedOwnNv.get(receivingCloserId)?.amount || 0) + ownNv,
          fromMemberId: node.memberId,
        });
        transferredOwnIds.add(node.memberId);
      });
      const resetCalculated = () =>
        model.rows.forEach((row) => {
          delete row.completedClosingMajorNv;
          delete row.completedClosingMinorNv;
          delete row.completedClosingNv;
          delete row.completedClosingPreviousTotal;
          delete row.closingDescendantDeltaNv;
        });
      const calculateNode = (node) => {
        let result = calculatePerformance(model, node.memberId, {
          majorTarget: node.majorTarget,
          minorTarget: node.minorTarget,
        });
        const manual = null;
        if (manual) {
          const ownNv = Math.max(
            0,
            Number(model.byId.get(node.memberId)?.ordPv || 0),
          );
          const rawMajor = Number(manual.majorNv || 0);
          const rawMinorWithOwn = Number(manual.minorNv || 0) + ownNv;
          result.effectiveTotals[result.majorIndex] = Math.max(
            rawMajor,
            rawMinorWithOwn,
          );
          result.effectiveTotals[result.minorIndex] = Math.min(
            rawMajor,
            rawMinorWithOwn,
          );
          result.deficits = result.effectiveTotals.map((total, index) =>
            Math.max(0, result.branchTargets[index] - total),
          );
          result.achieved = result.deficits.every((deficit) => deficit === 0);
          result.priority = result.achieved
            ? null
            : result.deficits[0] >= result.deficits[1]
              ? 0
              : 1;
        }
        const inherited = inheritedOwnNv.get(node.memberId);
        result = applyOwnSalesFlow(
          result,
          { majorTarget: node.majorTarget, minorTarget: node.minorTarget },
          {
            inheritedOwnNv: inherited?.amount || 0,
            suppressOwn: transferredOwnIds.has(node.memberId),
          },
        );
        if (inherited?.amount > 0) {
          result.inheritedOwnFromMemberId = inherited.fromMemberId;
        }
        return result;
      };
      const actualResults = new Map();
      nodes.forEach((node) => {
        const result = calculateNode(node);
        actualResults.set(node.memberId, result);
        const completion = plan.completions[node.memberId] || null;
        if (completion) applyClosingCompletion(model, node.memberId, completion);
      });
      resetCalculated();
      items = nodes.map((node) => {
        const result = calculateNode(node);
        node.lines = result.branchTargets.map((lineTarget, index) => ({
          index,
          lineTarget,
          childAllocation: null,
        }));
        const projection = projectClosingCompletion(result);
        const completion = plan.completions[node.memberId] || null;
        if (completion) {
          applyClosingCompletion(model, node.memberId, completion);
        } else if (projection.feasible !== false) {
          applyClosingCompletion(model, node.memberId, projection);
        }
        return {
          node,
          result,
          actualResult: actualResults.get(node.memberId),
          projection,
          completion,
        };
      });
      const nextIndex = items.findIndex(
        (item) => !item.completion && !item.skipped,
      );
      items.forEach((item, index) => {
        item.canComplete = index === nextIndex;
      });
      const topItem = items.find(
        (item) => item.node.memberId === plan.topMemberId,
      );
      const topMajorNv = topItem.completion
        ? Number(topItem.completion.majorNv)
        : Number(topItem.projection?.majorNv || 0);
      const topMinorNv = topItem.completion
        ? Number(topItem.completion.minorNv)
        : Number(topItem.projection?.minorNv || 0);
      const placements = items.flatMap((item) =>
        item.skipped
          ? []
          : item.projection.topUps
              .map((topUp, index) => ({
                closerMemberId: item.node.memberId,
                placementMemberId: item.result.placements[index].target
                  ? String(item.result.placements[index].target.userId)
                  : null,
                side: index === item.result.majorIndex ? "major" : "minor",
                salesWon: topUp.salesWon,
                addedNv: topUp.addedNv,
                excessNv: topUp.excessNv,
              }))
              .filter((placement) => placement.salesWon > 0),
      );
      const totalSalesWon = placements.reduce(
        (sum, placement) => sum + placement.salesWon,
        0,
      );
      const remainingSalesWon = items
        .filter((item) => !item.completion && !item.skipped)
        .flatMap((item) => item.projection.topUps)
        .reduce((sum, topUp) => sum + topUp.salesWon, 0);
      const infeasible = items.some(
        (item) => !item.skipped && item.projection.feasible === false,
      );
      const verified =
        !infeasible &&
        topMajorNv >= plan.topMajorTarget &&
        topMinorNv >= plan.topMinorTarget;
      const actualTop = topItem.actualResult;
      const currentMajorNv = topItem.completion
        ? Number(topItem.completion.majorNv)
        : Number(actualTop?.effectiveTotals?.[actualTop.majorIndex] || 0);
      const currentMinorNv = topItem.completion
        ? Number(topItem.completion.minorNv)
        : Number(actualTop?.effectiveTotals?.[actualTop.minorIndex] || 0);
      const currentAchieved =
        currentMajorNv >= plan.topMajorTarget &&
        currentMinorNv >= plan.topMinorTarget;
      if (currentAchieved && !topItem.completion) {
        const automaticCompletion = completionWhenAchieved(
          actualTop,
          lastSignature,
        );
        if (automaticCompletion) {
          plan.completions[plan.topMemberId] = automaticCompletion;
          topItem.completion = automaticCompletion;
          $("perfNotice").textContent =
            "하위 마감 완료 NV가 목표를 채워 최상위 사업자도 자동으로 마감 완료되었습니다.";
          queueMicrotask(() => persistPlan());
        }
      }
      lastRun = {
        allocation: {
          mode: "explicit",
          periodId: period.periodId,
          targetOverrides: plan.targetOverrides,
          currentPerformance: Object.fromEntries(
            items.map((item) => {
              const current = item.actualResult;
              return [
                item.node.memberId,
                {
                  majorNv: Number(
                    current?.effectiveTotals?.[current.majorIndex] || 0,
                  ),
                  minorNv: Number(
                    current?.effectiveTotals?.[current.minorIndex] || 0,
                  ),
                },
              ];
            }),
          ),
        },
        placements,
        topMajorNv,
        topMinorNv,
        topCompletedNv: topMajorNv + topMinorNv,
        currentMajorNv,
        currentMinorNv,
        currentAchieved,
        verified,
      };
      const topMember = model.byId.get(plan.topMemberId);
      const previous = previousPerformance[plan.topMemberId] || {
        majorNv: 0,
        minorNv: 0,
      };
      const rankOrder = ["회원", "DT", "GD", "RD", "ED", "DD", "SDD", "CDD", "PM", "IM"];
      const certifiedRank = String(
        topMember?.rankMaxName || topMember?.rankName || "회원",
      ).toUpperCase();
      const requiredIndex = Math.max(0, rankOrder.indexOf(certifiedRank));
      const direct = model.children.get(plan.topMemberId) || [];
      const qualifiedCount = (rootRow) => {
        if (!rootRow) return 0;
        const stack = [rootRow];
        const visited = new Set();
        let count = 0;
        while (stack.length) {
          const row = stack.pop();
          const id = String(row.userId);
          if (visited.has(id)) continue;
          visited.add(id);
          const rank = String(row.rankMaxName || row.rankName || "회원").toUpperCase();
          if (rankOrder.indexOf(rank) >= requiredIndex) count += 1;
          (model.children.get(id) || []).forEach((child) => stack.push(child));
        }
        return count;
      };
      const promotionMetrics = {
        firstRoundDtGroupNv:
          period.round === 1
            ? currentMajorNv + currentMinorNv
            : Number(firstRoundPerformance[plan.topMemberId]?.majorNv || 0) +
              Number(firstRoundPerformance[plan.topMemberId]?.minorNv || 0),
        round: period.round,
        previousMinorNv: previous.minorNv,
        currentMinorNv,
        gdEligible: rankOrder.indexOf(certifiedRank) >= rankOrder.indexOf("GD"),
        leftQualifiedCount: qualifiedCount(direct[0]),
        rightQualifiedCount: qualifiedCount(direct[1]),
      };
      const promotion =
        rankOrder.indexOf(certifiedRank) < rankOrder.indexOf("RD")
          ? evaluatePromotionPath(certifiedRank, promotionMetrics)
          : evaluatePromotion(certifiedRank, promotionMetrics);
      const promotionText =
        promotion.targetRank === "IM" && certifiedRank === "IM"
          ? "최고 직급"
          : rankOrder.indexOf(certifiedRank) < rankOrder.indexOf("GD")
            ? `${rankOrder[rankOrder.indexOf(certifiedRank) + 1]} 승급 · DT그룹 1차 매출 자료 확인 필요`
          : `${promotion.achieved ? promotion.achievedRank || promotion.targetRank : promotion.targetRank} 승급 ${promotion.achieved ? "가능" : "미달"} · ${promotion.reason}`;
      $("perfSummary").innerHTML =
        `<section class="recommend-card"><span>${period.year}년 ${period.month}월 ${period.round}차 · ${safe(topMember?.userName || "")} 기준</span><h2>현재 ${currentAchieved ? "마감 완료" : "마감 미달"} · 대 ${fmt(currentMajorNv)} / 소 ${fmt(currentMinorNv)}</h2><p>목표 대 ${fmt(plan.topMajorTarget)} / 소 ${fmt(plan.topMinorTarget)}</p><div class="period-performance"><span></span><b>전차수</b><b>현차수</b><b>합산</b><strong>대실적</strong><span>${fmt(previous.majorNv)}</span><span>${fmt(currentMajorNv)}</span><span>${fmt(Number(previous.majorNv || 0) + currentMajorNv)}</span><strong>소실적</strong><span>${fmt(previous.minorNv)}</span><span>${fmt(currentMinorNv)}</span><span>${fmt(Number(previous.minorNv || 0) + currentMinorNv)}</span></div><p class="promotion-status"><b>직급 승급 확인</b> · ${safe(promotionText)}</p><h3>추천 매출 합계 ${fmt(totalSalesWon)}원</h3><p>아직 넣지 않은 매출 ${fmt(remainingSalesWon)}원 · 매출 1,000원 = 810 NV · 최소 10,000원부터</p><p>추천 매출 반영 예상 · 대 ${fmt(topMajorNv)} / 소 ${fmt(topMinorNv)}</p><p><b>${verified ? "✅ 추천대로 진행하면 목표 달성 예상" : "⚠️ 추천 후에도 목표 미달 예상"}</b></p></section>`;
      $("perfResult").innerHTML = items
        .map((item, index) => stepHtml(item, index + 1, items.length))
        .join("");
      fitTrees();
      renderClosers();
    } catch (calculationError) {
      $("perfError").textContent = calculationError.message;
      $("perfSummary").replaceChildren();
      $("perfResult").replaceChildren();
    }
  };

  $("topMemberSelect").onchange = () => {
    plan.topMemberId = $("topMemberSelect").value;
    const allowed = new Set(
      descendantsOf(plan.topMemberId).map((row) => String(row.userId)),
    );
    plan.closingMemberIds = plan.closingMemberIds.filter(
      (id) => allowed.has(id) || id === plan.topMemberId,
    );
    if (!plan.closingMemberIds.includes(plan.topMemberId)) {
      plan.closingMemberIds.push(plan.topMemberId);
    }
    renderClosers();
  };
  $("closingOptions").onchange = () => {
    plan.closingMemberIds = [
      ...$("closingOptions").querySelectorAll("[data-closing-enabled]:checked"),
    ].map((input) => input.value);
    if (!plan.closingMemberIds.includes(plan.topMemberId)) {
      plan.closingMemberIds.push(plan.topMemberId);
    }
    $("closingCount").textContent =
      `${plan.closingMemberIds.filter((id) => id !== plan.topMemberId).length}명`;
    $("closingOptions")
      .querySelectorAll(".closing-member-setting")
      .forEach((setting) => {
        const checkbox = setting.querySelector("[data-closing-enabled]");
        const targets = setting.querySelector(".closing-member-targets");
        if (checkbox && targets) targets.hidden = !checkbox.checked;
      });
  };
  $("closingOptions").onclick = (event) => {
    const toggle = event.target.closest("[data-closing-tree-toggle]");
    if (!toggle) return;
    const id = toggle.dataset.closingTreeToggle;
    const children = $("closingOptions").querySelector(
      `[data-closing-tree-children="${CSS.escape(id)}"]`,
    );
    if (!children) return;
    children.hidden = !children.hidden;
    toggle.textContent = children.hidden ? "+" : "−";
    toggle.setAttribute(
      "aria-label",
      children.hidden ? "하위 계보 펼치기" : "하위 계보 접기",
    );
    if (children.hidden) collapsedCloserBranches.add(id);
    else collapsedCloserBranches.delete(id);
  };
  $("perfManualLinkForm").onsubmit = async (event) => {
    event.preventDefault();
    const parentId = $("perfLinkParent").value.trim();
    const childId = $("perfLinkChild").value.trim();
    const childName = $("perfLinkName").value.trim();
    $("perfLinkError").textContent = "";
    if (!ownerId) {
      $("perfLinkError").textContent = "로그인 후 수동 계보를 저장할 수 있습니다.";
      return;
    }
    if (result.inheritedOwnNv > 0 && result.inheritedOwnIndex != null) {
      const receiving = result.subMembers[result.inheritedOwnIndex];
      if (receiving) {
        const fromName =
          model.byId.get(result.inheritedOwnFromMemberId)?.userName || "상위";
        notes[String(receiving.userId)] =
          `${fromName} 본인매출 ${fmt(result.inheritedOwnNv)} NV 합산 · 합산 후 대·소실적 재비교`;
      }
    }
    if (!model.byId.has(parentId)) {
      $("perfLinkError").textContent = "현재 계보에서 상위 회원번호를 찾지 못했습니다.";
      return;
    }
    if (!childId || childId === parentId) {
      $("perfLinkError").textContent = "서로 다른 상위·하위 회원번호를 입력하세요.";
      return;
    }
    let cursor = model.byId.get(parentId);
    const visited = new Set();
    while (cursor && !visited.has(String(cursor.userId))) {
      const id = String(cursor.userId);
      if (id === childId) {
        $("perfLinkError").textContent = "순환되는 계보는 연결할 수 없습니다.";
        return;
      }
      visited.add(id);
      cursor = model.byId.get(String(cursor.ppId || ""));
    }
    const source =
      snapshotModels.find(({ model: sourceModel }) =>
        sourceModel.byId.has(childId),
      )?.model || (model.byId.has(childId) ? model : null);
    if (!source) {
      $("perfLinkError").textContent =
        "하위 사업자의 수집자료를 찾지 못했습니다. 해당 계정에서 먼저 매출받기를 실행하세요.";
      return;
    }
    const child = source.byId.get(childId);
    const { error: linkError } = await addManualLink(ownerId, {
      memberId: childId,
      memberName: childName || child?.userName || childId,
      parentId,
      note: "실적 탭 수동 연결",
    });
    if (linkError && !/duplicate|unique/i.test(linkError.message || "")) {
      $("perfLinkError").textContent =
        linkError.message || "수동 계보를 저장하지 못했습니다.";
      return;
    }
    attachPerformanceSubtree(model, source, childId, parentId);
    manualLinks = await loadManualLinks(ownerId);
    renderManualLinks();
    renderControls();
    runPlan();
    $("perfLinkError").textContent =
      "계보를 연결했습니다. 같은 회원번호는 한 번만 계산됩니다.";
  };
  $("perfLinkList").onclick = async (event) => {
    const button = event.target.closest("[data-remove-perf-link]");
    if (!button) return;
    const { error: removeError } = await removeManualLink(
      button.dataset.removePerfLink,
    );
    if (removeError) {
      $("perfLinkError").textContent = removeError.message;
      return;
    }
    await performancePage(root);
  };
  $("perfDate").onchange = async () => {
    period = closingPeriodForDate($("perfDate").value);
    if (period.round > 1) {
      const availableAt = new Date(`${period.endDate}T00:00:00`);
      availableAt.setDate(availableAt.getDate() + 1);
      const { data: periodSnapshot } = await supabase
        .from("nrc_sync_snapshots")
        .select("payload,collected_at,source_account_id")
        .eq("snapshot_type", "combined")
        .gte("collected_at", availableAt.toISOString())
        .order("collected_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (periodSnapshot) {
        data = periodSnapshot;
        const payload =
          typeof data.payload === "string"
            ? JSON.parse(data.payload)
            : data.payload;
        model = buildPerformanceModel(payload);
        collectedPerformance = new Map(
          model.rows.map((row) => [
            String(row.userId),
            {
              majorNv: Number(row.maxPv || 0),
              minorNv: Number(row.minPv || 0),
            },
          ]),
        );
        $("perfSource").textContent =
          `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · ${period.round}차 마감 다음 날 이후 첫 자료`;
      }
    }
    let loaded = null;
    if (storage === "supabase") {
      const { data: row } = await supabase
        .from(PLAN_TABLE)
        .select("*")
        .eq("period_id", period.periodId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (row) loaded = rowToPlan(row);
    } else {
      loaded = readJson(`${LOCAL_PLAN_KEY}:${period.periodId}`, null);
    }
    plan = loaded || defaultPlan();
    plan.periodId = period.periodId;
    plan.targetOverrides ||= {};
    plan.manualPerformance ||= {};
    plan.completions ||= {};
    if (!model.byId.has(String(plan.topMemberId))) plan = defaultPlan();
    await loadPreviousPerformance();
    renderControls();
    runPlan();
  };
  $("perfRun").onclick = async () => {
    runPlan();
    await persistPlan();
  };
  $("perfResult").addEventListener("toggle", fitTrees, true);
  window.addEventListener("resize", fitTrees);
  $("perfResult").onclick = async (event) => {
    const incomeToggle = event.target.closest("[data-toggle-income]");
    if (incomeToggle) {
      const memberId = incomeToggle.dataset.toggleIncome;
      const rootMemberId = incomeToggle.closest("[data-balance-output]")?.dataset.balanceOutput;
      if (!rootMemberId) return;
      if (!incomeAccounts.has(rootMemberId)) incomeAccounts.set(rootMemberId, new Set());
      const marked = incomeAccounts.get(rootMemberId);
      if (marked.has(memberId)) marked.delete(memberId);
      else marked.add(memberId);
      renderBalancePreviewInto(rootMemberId);
      return;
    }
    const badgeToggle = event.target.closest("[data-badge-toggle]");
    if (badgeToggle) {
      const leafId = badgeToggle.dataset.badgeToggle;
      const rootMemberId = badgeToggle.closest("[data-balance-output]")?.dataset.balanceOutput;
      if (!rootMemberId) return;
      if (!balanceOverrides.has(rootMemberId)) balanceOverrides.set(rootMemberId, new Set());
      const applied = balanceOverrides.get(rootMemberId);
      if (applied.has(leafId)) applied.delete(leafId);
      else applied.add(leafId);
      renderBalancePreviewInto(rootMemberId);
      return;
    }
    const completeButton = event.target.closest("[data-complete-closing]");
    const cancelButton = event.target.closest("[data-cancel-closing]");
    const balanceButton = event.target.closest("[data-balance-preview]");
    if (balanceButton) {
      renderBalancePreviewInto(balanceButton.dataset.balancePreview);
      return;
    }
    if (completeButton) {
      const id = completeButton.dataset.completeClosing;
      const item = items.find((entry) => entry.node.memberId === id);
      if (!item?.canComplete || item.projection.feasible === false) return;
      plan.completions[id] = {
        majorNv: item.projection.majorNv,
        minorNv: item.projection.minorNv,
        completedNv: item.projection.completedNv,
        completedAt: new Date().toISOString(),
        signature: lastSignature,
      };
      runPlan();
      await persistPlan();
    }
    if (cancelButton) {
      plan.completions = cancelCompletionCascade(
        model,
        plan.completions,
        cancelButton.dataset.cancelClosing,
      );
      runPlan();
      await persistPlan();
    }
  };

  renderManualLinks();
  renderControls();
  runPlan();
}
