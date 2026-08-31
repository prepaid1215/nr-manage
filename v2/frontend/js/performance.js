import { supabase } from "./supabase.js?v=20260829-34";
import {
  allocateClosingTargets,
  applyClosingCompletion,
  branchBreakdown,
  buildPerformanceModel,
  calculatePerformance,
  cancelCompletionCascade,
  comparePosition,
  minorIncentiveTier,
  nodeHasTarget,
  nodeTargets,
  planSignature,
  projectClosingCompletion,
  pruneInvalidCompletions,
  salesTopUpForDeficit,
  sortMembersDeepestFirst,
} from "./performance-calculator.js?v=20260831-60";
import { boxTreeHtml } from "./box-tree.js?v=20260831-58";
import { friendlyError } from "./errors.js?v=20260830-1";
import { isAppAdmin } from "./admin.js?v=20260831-14";

const PLAN_TABLE = "nrc_closing_plans";
const MIN_TREE_ZOOM = 0.72;
const LOCAL_PLAN_KEY = "nrc-closing-plan-backup";
const TOP_MEMBER_KEY = "nrc-perf-top-member-id";
const loadStoredTopMemberId = () => {
  try {
    return localStorage.getItem(TOP_MEMBER_KEY) || null;
  } catch {
    return null;
  }
};
const saveStoredTopMemberId = (id) => {
  try {
    if (id) localStorage.setItem(TOP_MEMBER_KEY, String(id));
  } catch {}
};
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

const flattenAllocation = (node, out = []) => {
  out.push(node);
  node.lines.forEach((line) => {
    if (line.childAllocation) flattenAllocation(line.childAllocation, out);
  });
  return out;
};

export async function performancePage(root, me) {
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>마감 실적 계산기</h2><p class="help">기준이 되는 최상위 마감 사업자와 목표만 정하면, 아래 사업자에게는 &quot;라인 합계&quot; 목표로 내려갑니다. 대·소를 각각 채우지 않으므로 매출이 덜 들어갑니다.</p></div></div><p id="perfSource" class="help"></p><p id="perfStorage" class="help"></p><button class="secondary compact" id="linkOtherAccounts" type="button" hidden>🔗 다른 계정 자동 연결</button><p id="linkOtherAccountsStatus" class="help" hidden></p><select id="topMemberSelect" hidden></select><section class="card"><div class="section-head"><div><span class="step">STEP 1 · 마감 사업자 등록</span><h2>사업자별 목표 대·소실적</h2><p class="help">최상위는 항상 포함됩니다. 자주 마감하는 하위 사업자를 미리 등록하고 목표를 입력하세요.</p></div><div><button class="secondary compact" id="changeTopBtn" type="button">최상위 변경</button><button class="secondary compact" id="addBusinessBtn" type="button">+ 사업자 등록</button></div></div><div id="businessGrid" class="business-grid"></div></section><section class="card closing-main-tree"><div class="section-head"><div><span class="step">STEP 2 · 계보도 확인</span><h2>사업자를 눌러 계보도를 전환하세요</h2><p class="help">클릭하면 그 사람 기준으로 계보도가 바뀌고, 계보도 안의 사람을 누르면 그 사람 기준으로 다시 펼쳐집니다.</p></div></div><div id="businessTabs" class="business-tabs"></div><div class="tree-nav"><button class="secondary compact" id="treeBack" type="button">← 뒤로</button><button class="secondary compact" id="treeHome" type="button">맨 위로</button><button class="secondary compact" id="treeToggleHidden" type="button">숨긴 카드 보기</button><span class="tree-zoom-controls"><button class="secondary compact" id="treeZoomOut" type="button" aria-label="축소">−</button><button class="secondary compact" id="treeZoomReset" type="button">100%</button><button class="secondary compact" id="treeZoomIn" type="button" aria-label="확대">＋</button></span></div><div id="closingMainTree" class="box-tree pannable-tree"><div class="tree-stage" id="closingMainTreeStage"><ul></ul></div></div><p id="focusSummary" class="help closing-focus-summary"></p></section><dialog id="treeTargetDialog" class="customer-dialog small"><form id="treeTargetForm"><div class="dialog-head"><h2 id="treeTargetTitle">목표 설정</h2><button id="treeTargetClose" type="button">×</button></div><label>대실적 목표 (NV)<input id="treeTargetMajor" type="number" min="0" step="1000" required></label><label>소실적 목표 (NV)<input id="treeTargetMinor" type="number" min="0" step="1000" required></label><p id="treeTargetAuto" class="help"></p><div class="customer-actions"><button class="secondary" id="treeTargetReset" type="button">자동값으로</button><button class="primary" type="submit">저장</button></div></form></dialog><details class="closing-member-picker" open><summary>마감할 하위 사업자 선택 <b id="closingCount">0명</b></summary><p class="help">체크하지 않은 회원의 라인은 라인 합계만 맞으면 그대로 통과합니다. 체크한 사업자는 라인 합계를 맞추면서 소실적이 인증직급 지급 기준선(DT 3만 · GD 이상 6만 NV) 이상이 되게 채웁니다.</p><div class="closing-picker-tools"><input id="closingFilter" type="search" placeholder="이름 또는 회원번호 검색"><button class="secondary compact" id="closingShowSingles" type="button">단독 계정 보기</button><button class="secondary compact" id="closingSelectAll" type="button">전체 선택</button><button class="secondary compact" id="closingSelectNone" type="button">전체 해제</button></div><div id="closingCollapsedGroups" class="closing-collapsed-groups"></div><div id="closingOptions" class="closing-member-options"></div></details><button id="perfRun" class="primary">자동 배분 계산</button><p id="perfNotice" class="help"></p><div id="perfError" class="error"></div></section><section id="perfSummary"></section><div id="stepTabs" class="business-tabs" hidden></div><section id="perfResult"></section>`;
  const $ = (id) => document.getElementById(id);
  const { data, error } = await supabase
    .from("nrc_sync_snapshots")
    .select("payload,collected_at,source_account_id")
    .eq("snapshot_type", "combined")
    .order("collected_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    $("perfError").textContent = error
      ? friendlyError(error, "실적 데이터를 불러오지 못했습니다.")
      : "수집된 JSON이 없습니다.";
    return;
  }

  let model;
  try {
    const payload =
      typeof data.payload === "string"
        ? JSON.parse(data.payload)
        : data.payload;
    model = buildPerformanceModel(payload);
  } catch (parseError) {
    $("perfError").textContent = parseError.message;
    return;
  }
  $("perfSource").textContent =
    `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · 계보도 가장 아래 사업자부터 순서대로 마감합니다.`;

  const { data: auth } = await supabase.auth.getUser().catch(() => ({}));
  const ownerId = auth?.user?.id || null;
  async function linkOtherAccounts() {
    const button = $("linkOtherAccounts"),
      status = $("linkOtherAccountsStatus");
    button.disabled = true;
    status.hidden = false;
    status.textContent = "다른 계정을 불러와 겹치는 회원을 찾는 중...";
    try {
      const { data: snapshots, error: snapshotError } = await supabase.rpc(
        "admin_all_latest_snapshots",
      );
      if (snapshotError) throw snapshotError;
      let addedRows = 0;
      const linkedNames = [];
      (snapshots || []).forEach((snapshot) => {
        if (snapshot.user_id === ownerId) return;
        let extModel;
        try {
          const extPayload =
            typeof snapshot.payload === "string"
              ? JSON.parse(snapshot.payload)
              : snapshot.payload;
          extModel = buildPerformanceModel(extPayload);
        } catch {
          return;
        }
        const before = model.byId.size;
        extModel.rows.forEach((row) => {
          const id = String(row.userId ?? "");
          if (!id || model.byId.has(id)) return;
          model.rows.push(row);
          model.byId.set(id, row);
        });
        const gained = model.byId.size - before;
        if (gained > 0) {
          addedRows += gained;
          linkedNames.push(snapshot.name || snapshot.username || "계정");
        }
      });
      if (addedRows > 0) {
        const children = new Map();
        model.rows.forEach((row) => {
          const parentId = String(row.ppId ?? "");
          if (!children.has(parentId)) children.set(parentId, []);
          children.get(parentId).push(row);
        });
        children.forEach((items) => items.sort(comparePosition));
        model.children = children;
        renderControls();
        renderMainTree();
        status.textContent = `${linkedNames.length}개 계정에서 회원 ${addedRows.toLocaleString()}명을 이어붙였습니다 (${linkedNames.join(", ")}).`;
      } else {
        status.textContent = "겹치는 회원이 있는 다른 계정을 찾지 못했습니다.";
      }
    } catch (linkError) {
      status.textContent = friendlyError(linkError, "다른 계정을 연결하지 못했습니다.");
    } finally {
      button.disabled = false;
    }
  }
  isAppAdmin().then((admin) => {
    if (admin) $("linkOtherAccounts").hidden = false;
  });
  $("linkOtherAccounts").onclick = linkOtherAccounts;
  let storage = ownerId ? "supabase" : "local";
  let storageNote = ownerId
    ? ""
    : "로그인 정보를 찾지 못해 이 브라우저에만 저장합니다.";
  let plan = null;
  let selfClosings = {};
  const collapsedGroups = new Set();
  let showSingles = false;
  let lastRun = null;
  let lastSignature = "";
  let items = [];
  const TREE_PINS_KEY = "nrc-perf-tree-pins";
  const loadTreePins = () => {
    try {
      return JSON.parse(localStorage.getItem(TREE_PINS_KEY)) || [];
    } catch {
      return [];
    }
  };
  const saveTreePins = (pins) => {
    try {
      localStorage.setItem(TREE_PINS_KEY, JSON.stringify(pins));
    } catch {}
  };
  let treePins = loadTreePins();
  const TREE_HIDDEN_KEY = "nrc-perf-tree-hidden";
  const loadHiddenTreeIds = () => {
    try {
      return new Set(JSON.parse(localStorage.getItem(TREE_HIDDEN_KEY)) || []);
    } catch {
      return new Set();
    }
  };
  const saveHiddenTreeIds = () => {
    try {
      localStorage.setItem(TREE_HIDDEN_KEY, JSON.stringify([...hiddenTreeIds]));
    } catch {}
  };
  let hiddenTreeIds = loadHiddenTreeIds();
  let showHiddenTree = false;
  let treeFocusId = null;
  let treeFocusHistory = [];
  let treeZoom = 1;
  let treeClickTimer = null;
  const navigateTree = (newId) => {
    if (treeFocusId && treeFocusId !== newId) treeFocusHistory.push(treeFocusId);
    treeFocusId = newId;
    renderMainTree();
    renderBusinessTabs();
  };

  const legacyPlan = () => {
    const selected = readJson("nrc-closing-members", [])
      .map(String)
      .filter((id) => model.byId.has(id));
    if (!selected.length) return null;
    const ordered = sortMembersDeepestFirst(model, selected);
    const top = ordered[ordered.length - 1];
    const targets = readJson("nrc-closing-member-targets", {});
    // 옛 대·소 목표는 최상위 목표로만 쓰고, 하위 목표는 라인 합계 규칙으로 다시 배분한다
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
      completions: Object.fromEntries(
        Object.entries(completions)
          .filter(([id]) => model.byId.has(String(id)))
          .map(([id, value]) => [id, { ...value, signature }]),
      ),
    };
  };

  const defaultPlan = () => {
    const own = me?.member_no
      ? model.rows.find((row) => String(row.userId) === String(me.member_no))
      : null;
    const top = own || model.rows[0];
    return {
      topMemberId: String(top.userId),
      topMajorTarget: 400000,
      topMinorTarget: 400000,
      closingMemberIds: [String(top.userId)],
      targetOverrides: {},
      acknowledged: {},
      completions: {},
    };
  };

  async function loadPlanFor(topMemberId) {
    if (storage === "supabase") {
      const { data: planRow, error: planError } = await supabase
        .from(PLAN_TABLE)
        .select("*")
        .eq("owner_id", ownerId)
        .eq("top_member_id", topMemberId)
        .maybeSingle();
      if (!planError && planRow) return rowToPlan(planRow);
    }
    return {
      topMemberId: String(topMemberId),
      topMajorTarget: 400000,
      topMinorTarget: 400000,
      closingMemberIds: [String(topMemberId)],
      targetOverrides: {},
      acknowledged: {},
      completions: {},
    };
  }

  async function saveGoalOnly(topMemberId, major, minor) {
    if (storage !== "supabase") {
      alert("Supabase 계정 저장일 때만 이 자리에서 바로 목표를 저장할 수 있습니다.");
      return false;
    }
    const { data: existingRow, error: loadError } = await supabase
      .from(PLAN_TABLE)
      .select("*")
      .eq("owner_id", ownerId)
      .eq("top_member_id", topMemberId)
      .maybeSingle();
    if (loadError) {
      alert(`목표 저장에 실패했습니다: ${loadError.message}`);
      return false;
    }
    const { id: _existingId, ...existingFields } = existingRow || {};
    const row = {
      ...existingFields,
      owner_id: ownerId,
      top_member_id: topMemberId,
      top_major_target: major,
      top_minor_target: minor,
      closing_member_ids: existingRow?.closing_member_ids || [topMemberId],
      updated_at: new Date().toISOString(),
    };
    const { error: saveError } = await supabase
      .from(PLAN_TABLE)
      .upsert(row, { onConflict: "owner_id,top_member_id" });
    if (saveError) {
      alert(`목표 저장에 실패했습니다: ${saveError.message}`);
      return false;
    }
    pinTargetCache.set(topMemberId, { major, minor });
    return true;
  }

  async function switchToTopMember(topMemberId) {
    if (!model.byId.has(String(topMemberId))) return;
    plan = await loadPlanFor(topMemberId);
    saveStoredTopMemberId(plan.topMemberId);
    plan.closingMemberIds = (plan.closingMemberIds || [])
      .map(String)
      .filter((id) => model.byId.has(id));
    if (!plan.closingMemberIds.includes(plan.topMemberId)) {
      plan.closingMemberIds.push(plan.topMemberId);
    }
    plan.targetOverrides = Object.fromEntries(
      Object.entries(plan.targetOverrides || {}).filter(
        ([id, override]) =>
          model.byId.has(String(id)) &&
          (override?.lineTarget != null ||
            override?.minorFloor != null ||
            (override?.majorTarget != null && override?.minorTarget != null)),
      ),
    );
    plan.acknowledged = Object.fromEntries(
      Object.entries(plan.acknowledged || {}).filter(([id]) =>
        model.byId.has(String(id)),
      ),
    );
    const descendantIds = new Set(
      descendantsOf(plan.topMemberId).map((row) => String(row.userId)),
    );
    Object.keys(selfClosings).forEach((id) => {
      if (descendantIds.has(id) && !plan.closingMemberIds.includes(id)) {
        plan.closingMemberIds.push(id);
      }
    });
    treeFocusId = plan.topMemberId;
    treeFocusHistory = [];
    renderControls();
    runPlan();
  }

  const rowToPlan = (row) => ({
    topMemberId: String(row.top_member_id),
    topMajorTarget: Number(row.top_major_target),
    topMinorTarget: Number(row.top_minor_target),
    closingMemberIds: (row.closing_member_ids || []).map(String),
    targetOverrides: row.allocation?.targetOverrides || {},
    acknowledged: row.allocation?.acknowledged || {},
    completions: row.completions || {},
  });

  const renderStorageNote = () => {
    $("perfStorage").textContent =
      storage === "supabase"
        ? "저장 위치: 내 계정(Supabase) · 다른 기기에서도 이어서 볼 수 있습니다."
        : `저장 위치: 이 브라우저만 · ${storageNote}`;
  };

  async function persistPlan() {
    pinTargetCache.delete(plan.topMemberId);
    const topCompletion = plan.completions[plan.topMemberId] || null;
    if (storage === "supabase") {
      const row = {
        owner_id: ownerId,
        top_member_id: plan.topMemberId,
        top_major_target: plan.topMajorTarget,
        top_minor_target: plan.topMinorTarget,
        closing_member_ids: plan.closingMemberIds,
        completions: plan.completions,
        allocation: lastRun?.allocation
          ? {
              ...lastRun.allocation,
              targetOverrides: plan.targetOverrides,
              acknowledged: plan.acknowledged,
            }
          : Object.keys(plan.targetOverrides || {}).length ||
              Object.keys(plan.acknowledged || {}).length
            ? {
                targetOverrides: plan.targetOverrides,
                acknowledged: plan.acknowledged,
              }
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
        .upsert(row, { onConflict: "owner_id,top_member_id" });
      if (!saveError) {
        renderStorageNote();
        return true;
      }
      storage = "local";
      storageNote = /does not exist|schema cache|relation/i.test(
        saveError.message,
      )
        ? "Supabase에서 RUN_012_CLOSING_PLANS.sql을 먼저 실행하세요. 기존 데이터는 삭제하지 않았습니다."
        : `Supabase 저장 실패: ${saveError.message} (기존 데이터는 그대로 남아 있습니다)`;
    }
    try {
      localStorage.setItem(LOCAL_PLAN_KEY, JSON.stringify(plan));
    } catch {}
    renderStorageNote();
    return false;
  }

  if (storage === "supabase") {
    // 여러 사업자(핀)를 등록하면 nrc_closing_plans에 사업자별로 행이 여러 개
    // 생긴다. "가장 최근에 수정된 행"을 최상위로 오해하면, 핀 목표만 바꿔도
    // 새로고침 때 최상위가 그 핀으로 바뀌어버린다. 그래서 이 브라우저가
    // 마지막으로 최상위로 쓰던 사업자를 기억해뒀다가 그 행을 정확히 찾는다.
    const storedTopId = loadStoredTopMemberId();
    const query = supabase.from(PLAN_TABLE).select("*").eq("owner_id", ownerId);
    const { data: planRow, error: planError } = storedTopId
      ? await query.eq("top_member_id", storedTopId).maybeSingle()
      : await query.order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (planError) {
      storage = "local";
      storageNote = /does not exist|schema cache|relation/i.test(
        planError.message,
      )
        ? "Supabase에서 RUN_012_CLOSING_PLANS.sql을 먼저 실행하면 계정에 저장됩니다."
        : `Supabase 조회 오류: ${planError.message}`;
    } else if (planRow) {
      plan = rowToPlan(planRow);
    } else if (storedTopId && model.byId.has(storedTopId)) {
      // 기억해둔 최상위 사업자는 아직 목표를 저장한 적이 없는 상태 —
      // 다른 사업자 행으로 잘못 대체하지 말고 그 사람 기준의 새 계획으로 시작한다.
      plan = defaultPlan();
      plan.topMemberId = storedTopId;
      plan.closingMemberIds = [storedTopId];
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
      (storage === "local" && readJson(LOCAL_PLAN_KEY, null)) ||
      legacyPlan() ||
      defaultPlan();
  }
  if (!model.byId.has(String(plan.topMemberId))) plan = defaultPlan();
  saveStoredTopMemberId(plan.topMemberId);
  plan.closingMemberIds = (plan.closingMemberIds || [])
    .map(String)
    .filter((id) => model.byId.has(id));
  if (!plan.closingMemberIds.includes(plan.topMemberId)) {
    plan.closingMemberIds.push(plan.topMemberId);
  }
  // 옛 형식({majorTarget,minorTarget})은 라인 합계 규칙에서 쓰지 않으므로 버린다
  plan.targetOverrides = Object.fromEntries(
    Object.entries(plan.targetOverrides || {}).filter(
      ([id, override]) =>
        model.byId.has(String(id)) &&
        (override?.lineTarget != null || override?.minorFloor != null),
    ),
  );
  plan.acknowledged = Object.fromEntries(
    Object.entries(plan.acknowledged || {}).filter(([id]) =>
      model.byId.has(String(id)),
    ),
  );
  renderStorageNote();

  const effectiveCompletion = (id) => plan.completions[id] || selfClosings[id] || null;

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

  const openTreeTarget = (memberId) => {
    const row = model.byId.get(memberId);
    if (!row) return;
    if (memberId === plan.topMemberId) {
      $("topMajor").focus();
      return;
    }
    const isDescendant = descendantsOf(plan.topMemberId).some(
      (r) => String(r.userId) === memberId,
    );
    const item = items.find((entry) => entry.node.memberId === memberId);
    const node = item?.node;
    const existingOverride = plan.targetOverrides?.[memberId];
    $("treeTargetTitle").textContent = `${row.userName} 목표 설정`;
    $("treeTargetMajor").value =
      node?.mode === "sides" ? node.majorTarget : (existingOverride?.majorTarget ?? "");
    $("treeTargetMinor").value =
      node?.mode === "sides" ? node.minorTarget : (existingOverride?.minorTarget ?? "");
    $("treeTargetAuto").textContent = node
      ? `자동 배분값 라인 합계 ${fmt(node.autoLineTarget)} · 소실적 기준선 ${fmt(node.autoMinorFloor)}`
      : isDescendant
        ? "아직 마감 대상으로 체크되지 않았습니다. 저장하면 자동으로 추가됩니다."
        : "이 사업자는 최상위 사업자의 하위가 아니어서 목표를 설정할 수 없습니다.";
    $("treeTargetForm").hidden = !isDescendant;
    $("treeTargetDialog").dataset.member = memberId;
    $("treeTargetDialog").showModal();
  };
  const renderMainTree = (options = {}) => {
    const box = $("closingMainTree"),
      stage = $("closingMainTreeStage");
    if (!box || !stage) return;
    const preserveScroll = Boolean(options.preserveScroll);
    const prevScrollTop = box.scrollTop,
      prevScrollLeft = box.scrollLeft;
    const badges = {},
      notes = {},
      sales = {};
    items.forEach((item) => {
      if (item.skipped) return;
      const { node, completion, projection, result } = item;
      badges[node.memberId] =
        node.mode === "sides"
          ? `대 ${fmt(node.majorTarget)} / 소 ${fmt(node.minorTarget)}`
          : `목표 ${fmt(node.lineTarget)}`;
      notes[node.memberId] = completion ? "마감 완료" : "진행 예정";
      (projection?.sales || []).forEach((sale) => {
        if (!sale.memberId || sale.salesWon <= 0) return;
        const isSelf =
          result?.placements[sale.lineIndex]?.kind === "self" ||
          sale.memberId === node.memberId;
        sales[sale.memberId] =
          `${fmt(sale.salesWon)}원 → +${fmt(sale.addedNv)} NV${isSelf ? " (본인 코드)" : ""}`;
      });
    });
    if (!treeFocusId || !model.byId.has(treeFocusId))
      treeFocusId = plan.topMemberId;
    const focusTargets = businessCardTargets().find(
      (card) => card.id === treeFocusId,
    );
    let focusResult = null,
      focusProjection = null;
    if (focusTargets?.major && focusTargets?.minor) {
      try {
        focusResult = calculatePerformance(model, treeFocusId, {
          majorTarget: focusTargets.major,
          minorTarget: focusTargets.minor,
        });
        focusProjection = projectClosingCompletion(focusResult);
        (focusProjection.sales || []).forEach((sale) => {
          if (!sale.memberId || sale.salesWon <= 0) return;
          if (sales[sale.memberId]) return;
          const isSelf =
            focusResult.placements[sale.lineIndex]?.kind === "self" ||
            sale.memberId === treeFocusId;
          sales[sale.memberId] =
            `${fmt(sale.salesWon)}원 → +${fmt(sale.addedNv)} NV${isSelf ? " (본인 코드)" : ""}`;
        });
      } catch {
        focusResult = null;
      }
    }
    const focusName = model.byId.get(treeFocusId)?.userName || "이름 없음";
    const focusSummary = $("focusSummary");
    if (focusSummary) {
      if (!focusTargets?.major || !focusTargets?.minor) {
        focusSummary.textContent = "";
      } else if (focusResult && focusProjection?.feasible !== false) {
        const currentMajor = fmt(focusResult.effectiveTotals[focusResult.majorIndex]);
        const currentMinor = fmt(focusResult.effectiveTotals[focusResult.minorIndex]);
        const saleTotal = (focusProjection.sales || []).reduce(
          (sum, sale) => sum + sale.salesWon,
          0,
        );
        focusSummary.textContent = saleTotal > 0
          ? `${focusName} 마감안 · 현재 대/소 ${currentMajor} / ${currentMinor} · 목표 대/소 ${fmt(focusTargets.major)} / ${fmt(focusTargets.minor)} · 추천 매출 ${fmt(saleTotal)}원`
          : `${focusName} 마감안 · 이미 목표를 채웠습니다 (현재 대/소 ${currentMajor} / ${currentMinor})`;
      } else {
        focusSummary.textContent = `${focusName} 마감안 · 부족한 라인에 배치 가능한 코드가 없어 마감할 수 없습니다.`;
      }
    }
    stage.style.zoom = treeZoom;
    stage.innerHTML = boxTreeHtml(model, treeFocusId, {
      depth: 8,
      badges,
      notes,
      sales,
      hideDate: true,
      clickable: true,
      selectedId: plan.topMemberId,
      totalOf: (row) => branchBreakdown(row).total,
      hideable: true,
      hiddenIds: hiddenTreeIds,
      showHidden: showHiddenTree,
    });
    const hiddenBtn = $("treeToggleHidden");
    if (hiddenBtn) {
      hiddenBtn.textContent = showHiddenTree
        ? "숨긴 카드 감추기"
        : `숨긴 카드 보기${hiddenTreeIds.size ? ` (${hiddenTreeIds.size})` : ""}`;
      hiddenBtn.disabled = !showHiddenTree && hiddenTreeIds.size === 0;
    }
    if (preserveScroll) {
      box.scrollTop = prevScrollTop;
      requestAnimationFrame(() => {
        box.scrollLeft = prevScrollLeft;
      });
    } else {
      box.scrollTop = 0;
      requestAnimationFrame(() => {
        box.scrollLeft = Math.max(0, (box.scrollWidth - box.clientWidth) / 2);
      });
    }
  };
  const setTreeZoom = (value) => {
    treeZoom = Math.min(1.8, Math.max(0.3, value));
    const stage = $("closingMainTreeStage");
    if (stage) stage.style.zoom = treeZoom;
    $("treeZoomReset").textContent = `${Math.round(treeZoom * 100)}%`;
  };
  const pinTargetCache = new Map();
  const depthOf = (id) => {
    let depth = 0,
      current = model.byId.get(String(id));
    const visited = new Set();
    while (current?.ppId && !visited.has(String(current.ppId))) {
      visited.add(String(current.ppId));
      current = model.byId.get(String(current.ppId));
      if (!current) break;
      depth += 1;
    }
    return depth;
  };
  const businessCardTargets = () => {
    const topId = plan.topMemberId;
    const otherPins = treePins.filter((pin) => pin.id !== topId);
    return [
      { id: topId, isTop: true, major: plan.topMajorTarget, minor: plan.topMinorTarget },
      ...otherPins.map((pin) => ({
        id: pin.id,
        isTop: false,
        major: pinTargetCache.get(pin.id)?.major || 0,
        minor: pinTargetCache.get(pin.id)?.minor || 0,
      })),
    ].filter((card) => model.byId.has(card.id));
  };
  const cardStatusHtml = (id, major, minor) => {
    if (!major || !minor)
      return `<div class="business-status"><span>계산 상태</span><b>목표를 입력하세요</b></div>`;
    try {
      const result = calculatePerformance(model, id, {
        majorTarget: major,
        minorTarget: minor,
      });
      const projection = projectClosingCompletion(result);
      const currentMajor = fmt(result.effectiveTotals[result.majorIndex]);
      const currentMinor = fmt(result.effectiveTotals[result.minorIndex]);
      if (projection.feasible === false)
        return `<div class="business-status need"><span>계산 상태</span><b>마감 위치 부족</b><small>빈 라인 또는 배치 가능한 코드 확인 필요</small></div>`;
      const saleTotal = (projection.sales || []).reduce(
        (sum, sale) => sum + sale.salesWon,
        0,
      );
      if (saleTotal > 0)
        return `<div class="business-status need"><span>추천 매출</span><b>${fmt(saleTotal)}원</b><small>현재 대 ${currentMajor} · 소 ${currentMinor}</small></div>`;
      return `<div class="business-status"><span>계산 상태</span><b>목표 달성</b><small>현재 대 ${currentMajor} · 소 ${currentMinor}</small></div>`;
    } catch (err) {
      return `<div class="business-status need"><span>계산 상태</span><b>계산 불가</b><small>${safe(err.message)}</small></div>`;
    }
  };
  const focusBusiness = (id) => {
    navigateTree(id);
    const box = $("closingMainTree");
    if (box) box.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const renderBusinessTabs = () => {
    const box = $("businessTabs");
    if (!box) return;
    box.innerHTML = businessCardTargets()
      .map((card) => {
        const row = model.byId.get(card.id);
        let saleTotal = 0,
          achieved = false;
        if (card.major && card.minor) {
          try {
            const result = calculatePerformance(model, card.id, {
              majorTarget: card.major,
              minorTarget: card.minor,
            });
            const projection = projectClosingCompletion(result);
            saleTotal = (projection.sales || []).reduce(
              (sum, sale) => sum + sale.salesWon,
              0,
            );
            achieved = projection.feasible !== false && saleTotal === 0;
          } catch {}
        }
        return `<button class="business-tab${saleTotal > 0 ? " sale" : ""}${card.id === treeFocusId ? " active" : ""}" data-business-tab="${safe(card.id)}" type="button">${safe(row?.userName || "이름 없음")}${saleTotal > 0 ? ` · ${fmt(saleTotal)}원` : achieved ? " · 달성" : ""}</button>`;
      })
      .join("");
    box.querySelectorAll("[data-business-tab]").forEach(
      (tab) => (tab.onclick = () => focusBusiness(tab.dataset.businessTab)),
    );
  };
  const renderBusinessGrid = async () => {
    const box = $("businessGrid");
    if (!box) return;
    const topId = plan.topMemberId;
    const otherPins = treePins.filter((pin) => pin.id !== topId);
    await Promise.all(
      otherPins
        .filter((pin) => !pinTargetCache.has(pin.id))
        .map(async (pin) => {
          const loaded = await loadPlanFor(pin.id);
          pinTargetCache.set(pin.id, {
            major: loaded.topMajorTarget,
            minor: loaded.topMinorTarget,
          });
        }),
    );
    const cards = businessCardTargets();
    box.innerHTML = cards
      .map((card) => {
        const row = model.byId.get(card.id);
        return `<article class="business-card${card.isTop ? " root" : ""}" data-business="${safe(card.id)}"><div class="business-name"><b>${safe(row.userName || "이름 없음")}${card.isTop ? " · 최상위" : ""}</b><span>*${safe(card.id)} · ${safe(row.rankMaxName || "회원")} · ${depthOf(card.id)}단계</span></div><label class="field"><span>목표 대실적</span><div class="input-unit"><input data-goal="major" ${card.isTop ? 'id="topMajor"' : ""} type="number" min="1" step="1000" value="${card.major || ""}"><b>NV</b></div></label><label class="field"><span>목표 소실적</span><div class="input-unit"><input data-goal="minor" ${card.isTop ? 'id="topMinor"' : ""} type="number" min="1" step="1000" value="${card.minor || ""}"><b>NV</b></div></label>${cardStatusHtml(card.id, card.major, card.minor)}<div class="business-actions"><button class="secondary compact" data-view-business="${safe(card.id)}" type="button">계보도 보기</button>${card.isTop ? "" : `<button class="secondary compact danger" data-remove-business="${safe(card.id)}" type="button">등록 해제</button>`}</div></article>`;
      })
      .join("");
    box.querySelectorAll("[data-business]").forEach((card) => {
      const id = card.dataset.business;
      const refresh = () => {
        const major = Number(card.querySelector('[data-goal="major"]').value || 0);
        const minor = Number(card.querySelector('[data-goal="minor"]').value || 0);
        card.querySelector(".business-status").outerHTML = cardStatusHtml(id, major, minor);
        renderBusinessTabs();
        if (id === treeFocusId) renderMainTree();
      };
      card.querySelectorAll("[data-goal]").forEach((input) => {
        input.oninput = refresh;
        input.onchange = async () => {
          const major = Number(card.querySelector('[data-goal="major"]').value || 0);
          const minor = Number(card.querySelector('[data-goal="minor"]').value || 0);
          if (id === topId) {
            plan.topMajorTarget = major;
            plan.topMinorTarget = minor;
            await saveGoalOnly(id, major, minor);
            runPlan();
            await persistPlan();
          } else {
            pinTargetCache.set(id, { major, minor });
            await saveGoalOnly(id, major, minor);
          }
        };
      });
    });
    box.querySelectorAll("[data-view-business]").forEach(
      (button) => (button.onclick = () => focusBusiness(button.dataset.viewBusiness)),
    );
    box.querySelectorAll("[data-remove-business]").forEach(
      (button) =>
        (button.onclick = () => {
          treePins = treePins.filter((pin) => pin.id !== button.dataset.removeBusiness);
          saveTreePins(treePins);
          pinTargetCache.delete(button.dataset.removeBusiness);
          renderBusinessGrid();
          renderBusinessTabs();
        }),
    );
    renderBusinessTabs();
  };
  $("changeTopBtn").onclick = async () => {
    const query = prompt(
      `현재 최상위: ${model.byId.get(plan.topMemberId)?.userName || "-"}\n새 최상위로 바꿀 사업자 이름 또는 회원번호를 입력하세요.`,
    );
    if (!query) return;
    const trimmed = query.trim(),
      q = trimmed.toLowerCase();
    const match = model.rows.find(
      (row) =>
        String(row.userId) === trimmed ||
        String(row.userName || "").toLowerCase().includes(q),
    );
    if (!match) {
      alert("일치하는 회원을 찾지 못했습니다.");
      return;
    }
    await switchToTopMember(String(match.userId));
  };
  $("addBusinessBtn").onclick = () => {
    const query = prompt("추가할 사업자 이름 또는 회원번호를 입력하세요.");
    if (!query) return;
    const trimmed = query.trim(),
      q = trimmed.toLowerCase();
    const match = model.rows.find(
      (row) =>
        String(row.userId) === trimmed ||
        String(row.userName || "").toLowerCase().includes(q),
    );
    if (!match) {
      alert("일치하는 회원을 찾지 못했습니다.");
      return;
    }
    const id = String(match.userId);
    if (!treePins.some((pin) => pin.id === id)) {
      treePins = [...treePins, { id, name: match.userName }];
      saveTreePins(treePins);
    }
    pinTargetCache.delete(id);
    renderBusinessGrid();
  };

  const renderControls = () => {
    $("topMemberSelect").innerHTML = model.rows
      .map(
        (row) =>
          `<option value="${safe(row.userId)}" ${String(row.userId) === plan.topMemberId ? "selected" : ""}>${safe(row.userName)} (${safe(row.userId)})</option>`,
      )
      .join("");
    renderBusinessGrid();
    renderClosers();
  };

  const memberCheckHtml = (row, label) =>
    `<label class="check"><input type="checkbox" value="${safe(row.userId)}" ${plan.closingMemberIds.includes(String(row.userId)) ? "checked" : ""}> <span>${safe(label)} <small>(${safe(row.userId)})</small></span></label>`;
  const renderClosers = () => {
    const rows = descendantsOf(plan.topMemberId);
    $("closingCount").textContent =
      `${plan.closingMemberIds.filter((id) => id !== plan.topMemberId).length}명`;
    const groups = new Map();
    rows.forEach((row) => {
      if (!groups.has(row.userName)) groups.set(row.userName, []);
      groups.get(row.userName).push(row);
    });
    for (const name of [...collapsedGroups]) {
      if (!groups.has(name) || groups.get(name).length < 2)
        collapsedGroups.delete(name);
    }
    $("closingOptions").innerHTML = rows.length
      ? [...groups.entries()]
          .map(([name, members]) => {
            if (members.length < 2) return memberCheckHtml(members[0], name);
            if (collapsedGroups.has(name)) return "";
            const suffixed = members.map((row, index) => [
              row,
              index === 0 ? name : `${name}${index}`,
            ]);
            return `<div class="closing-group" data-group="${safe(name)}"><div class="closing-group-head"><button class="closing-group-toggle" data-toggle-group="${safe(name)}" type="button">-</button><b>${safe(suffixed.map(([, label]) => label).join(" "))}</b></div><div class="closing-group-members">${suffixed.map(([row, label]) => memberCheckHtml(row, label)).join("")}</div></div>`;
          })
          .join("")
      : '<p class="help">이 사업자 아래에는 하위 회원이 없습니다.</p>';
    $("closingCollapsedGroups").innerHTML = [...collapsedGroups]
      .map(
        (name) =>
          `<button class="closing-collapsed-chip" data-expand-group="${safe(name)}" type="button">+ ${safe(name)} 외 ${groups.get(name).length - 1}명</button>`,
      )
      .join("");
    const singleCount = [...groups.values()].filter(
      (members) => members.length < 2,
    ).length;
    $("closingShowSingles").textContent = showSingles
      ? `단독 계정 숨기기 (${singleCount}명)`
      : `단독 계정 보기 (${singleCount}명)`;
    $("closingShowSingles").hidden = !singleCount;
    applyClosingFilter();
  };
  const applyClosingFilter = () => {
    const query = $("closingFilter").value.trim().toLowerCase();
    $("closingOptions")
      .querySelectorAll(".closing-group")
      .forEach((group) => {
        let anyVisible = false;
        group.querySelectorAll("label").forEach((label) => {
          const matches =
            !query || label.textContent.toLowerCase().includes(query);
          label.hidden = !matches;
          if (matches) anyVisible = true;
        });
        group.hidden = Boolean(query) && !anyVisible;
      });
    $("closingOptions")
      .querySelectorAll(":scope > label")
      .forEach((label) => {
        const matches = !query || label.textContent.toLowerCase().includes(query);
        label.hidden = !matches || (!query && !showSingles);
      });
  };

  const lineHtml = (item, index) => {
    const { node, result, projection } = item;
    const line = node.lines[index];
    // 대·소는 매출을 넣은 뒤 기준으로 표시한다 (작은 줄부터 채우면 뒤집힐 수 있다)
    const majorIndex = projection.projectedMajorIndex ?? result.majorIndex;
    const isMajor = index === majorIndex;
    const branch = result.branches[index];
    const subMember = result.subMembers[index];
    const topUp = projection.topUps[index];
    const deficit = result.deficits[index];
    let role;
    if (!subMember?.length) {
      role =
        index === result.ownContributionIndex
          ? "하위 회원이 없어 본인 매출로 채우는 라인"
          : "하위 회원이 없는 라인";
    } else if (line.childAllocation) {
      const child = line.childAllocation;
      const closer = model.byId.get(child.memberId);
      const childDone = Boolean(effectiveCompletion(child.memberId));
      const targetKind = child.overridden ? "직접 입력" : "자동";
      role = branch.completed
        ? `하위 마감 ${safe(closer?.userName || "")} ${childDone ? "완료값" : "예상 완료값"} ${fmt(branch.total)} NV 반영`
        : `하위 마감 ${safe(closer?.userName || "")} 진행 예정 (${targetKind} 라인 합계 ${fmt(child.lineTarget)}${child.minorFloor > 0 ? ` · 소실적 기준선 ${fmt(child.minorFloor)}` : ""})`;
    } else {
      role = "마감 대상 아님 · 전체 NV 그대로 반영";
    }
    const ownNote =
      index === result.ownContributionIndex && result.minorOwnContribution > 0
        ? `<small>본인 매출 ${fmt(result.minorOwnContribution)} NV가 이 라인에 합산됩니다.</small>`
        : "";
    const projectedTotal = projection.projectedTotals?.[index];
    const hasTopUp = Boolean(topUp?.salesWon > 0);
    const totalsLine = hasTopUp
      ? `<small><b>실제(현재)</b> ${fmt(result.effectiveTotals[index])} NV · 라인 목표 ${fmt(line.lineTarget)} · ${fmt(deficit)} NV 부족 → <b>매출 넣으면(가상)</b> ${fmt(projectedTotal)} NV · 목표 채움</small>`
      : `<small><b>실제(현재)</b> ${fmt(result.effectiveTotals[index])} NV · 라인 목표 ${fmt(line.lineTarget)} · ${deficit > 0 ? `${fmt(deficit)} NV 부족 · 넣을 코드 없음` : "목표를 채웠습니다"}</small>`;
    return `<article class="closing-line"><b>서브${index + 1} · ${isMajor ? "대실적" : "소실적"}</b><small>${role}</small>${ownNote}${totalsLine}</article>`;
  };

  const treeHtml = (item) => {
    const { node, result, projection } = item;
    const badges = {};
    const notes = {};
    const sales = {};
    const majorIndex = projection.projectedMajorIndex ?? result.majorIndex;
    (projection.sales || []).forEach((sale) => {
      if (!sale.memberId || sale.salesWon <= 0) return;
      const isSelf =
        result.placements[sale.lineIndex]?.kind === "self" ||
        sale.memberId === node.memberId;
      sales[sale.memberId] =
        `${fmt(sale.salesWon)}원 → +${fmt(sale.addedNv)} NV${isSelf ? " (본인 코드)" : ""}`;
    });
    result.subMembers.forEach((group, index) => {
      if (!group?.length) return;
      const side = index === majorIndex ? "대실적" : "소실적";
      const deficit = result.deficits[index];
      const label = `서브${index + 1} · ${side} · 라인 ${fmt(result.effectiveTotals[index])} / 목표 ${fmt(node.lines[index].lineTarget)}${deficit > 0 ? ` · ${fmt(deficit)} 부족` : " · 채움"}`;
      group.forEach((subMember) => {
        notes[String(subMember.userId)] = label;
      });
    });
    const ownIndex = result.ownContributionIndex;
    if (result.minorOwnContribution > 0) {
      notes[node.memberId] =
        `본인 매출 ${fmt(result.minorOwnContribution)} NV는 서브${ownIndex + 1} 라인에 합산`;
    }
    return `<details class="closing-tree"${item.canComplete ? " open" : ""}><summary>계보도로 확인하기</summary><div class="box-tree compact">${boxTreeHtml(model, node.memberId, {
      depth: 3,
      badges,
      notes,
      sales,
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

  // 소실적 지급 구간 안내. 기준선을 넘긴 뒤 더 채울지는 사용자가 정한다.
  const payoutHtml = (item, minorNv, locked) => {
    const member = model.byId.get(item.node.memberId);
    const tier = minorIncentiveTier(member, minorNv);
    const id = item.node.memberId;
    if (tier.level === 0) {
      return `<p class="closing-payout help">인증직급 ${safe(member?.rankMaxName || "회원")} · 매출장려금 지급 대상이 아니라 소실적 기준선을 적용하지 않았습니다.</p>`;
    }
    const rateText =
      tier.rate != null
        ? `${tier.rate}% 구간`
        : tier.amountWon != null
          ? `${fmt(tier.amountWon)}원 구간`
          : `지급 기준선 ${fmt(tier.floor)} NV 미만`;
    const nextText = tier.nextMin
      ? ` · 다음 구간 ${fmt(tier.nextMin)} NV까지 ${fmt(tier.nextShortfallNv)} NV 부족 (약 ${fmt(salesTopUpForDeficit(tier.nextShortfallNv).salesWon)}원)`
      : "";
    const kept = Boolean(plan.acknowledged?.[id]);
    const button = locked
      ? ""
      : `<button class="secondary compact" data-keep-target="${safe(id)}" type="button">${kept ? "다시 검토" : "이대로 둔다"}</button>`;
    return `<p class="closing-payout"><span>소실적 ${fmt(minorNv)} NV · 인증직급 ${safe(member?.rankMaxName || "회원")} 기준선 ${fmt(tier.floor)} NV · ${rateText}${nextText}</span>${kept ? "<em>이대로 두기로 했습니다</em>" : ""}${button}</p>`;
  };

  const stepHtml = (item, order, total) => {
    const member = model.byId.get(item.node.memberId);
    const parent = member?.ppId ? model.byId.get(String(member.ppId)) : null;
    const breadcrumb = parent
      ? `<p class="closing-breadcrumb">상위 사업자 <b>${safe(parent.userName)}</b> (${safe(parent.userId)}) 아래</p>`
      : `<p class="closing-breadcrumb">계보 최상위 사업자</p>`;
    const title = `${order}/${total} · ${safe(member?.userName || "이름 없음")} <small>(${safe(item.node.memberId)})</small>`;
    if (item.skipped) {
      return `<section class="card closing-step" data-step-member="${safe(item.node.memberId)}"><div class="section-head"><h2>${title}</h2><b>추가 마감 불필요</b></div>${breadcrumb}<p class="help">위에서 내려온 목표가 이미 라인 실적으로 채워져 추가 마감이 필요 없습니다.</p></section>`;
    }
    const { node, result, projection, completion } = item;
    const todoSales = (projection.sales || []).filter(
      (sale) => sale.salesWon > 0,
    );
    const todoHtml = completion
      ? ""
      : todoSales.length
        ? `<div class="closing-todo"><b>지금 할 일 · 매출 넣기</b>${todoSales
            .map(
              (sale) =>
                `<span>${safe(sale.target?.userName || "-")} <small>(${safe(sale.memberId || "-")})</small> 코드에 <b>${fmt(sale.salesWon)}원</b> → +${fmt(sale.addedNv)} NV</span>`,
            )
            .join("")}${todoSales.length > 1 ? `<small>합계 ${fmt(todoSales.reduce((sum, sale) => sum + sale.salesWon, 0))}원 · 한 코드에 몰리지 않게 나눴습니다.</small>` : ""}</div>`
        : `<div class="closing-todo done"><b>지금 할 일 없음</b> · 이미 목표를 채웠습니다</div>`;
    const state = completion
      ? "완료"
      : item.canComplete
        ? "지금 마감할 차례"
        : "앞 순서 완료 후 진행";
    const warn = result.warnings.length
      ? `<p class="error">${result.warnings.map(safe).join(" ")}</p>`
      : "";
    const button = completion
      ? completion.external
        ? `<p class="help">이 사업자 본인 계정에서 직접 마감 완료한 값입니다 · 취소는 본인 계정에서만 가능합니다.</p>`
        : `<button class="secondary" data-cancel-closing="${safe(node.memberId)}" type="button">마감 취소</button>`
      : `<button class="primary" data-complete-closing="${safe(node.memberId)}" type="button" ${item.canComplete && projection.feasible !== false ? "" : "disabled"}>${projection.feasible === false ? "마감 불가" : item.canComplete ? "마감 완료로 표시" : "앞 순서부터 완료하세요"}</button>`;
    const finalMinorNv = completion ? completion.minorNv : projection.minorNv;
    const final = completion
      ? `<p><b>확정 마감</b>${completion.external ? " <em>(본인 계정 마감)</em>" : ""} · 대 ${fmt(completion.majorNv)} / 소 ${fmt(completion.minorNv)} → 상위 라인에 <b>${fmt(completion.completedNv)} NV</b> 반영</p>`
      : `<p><b>예상 마감</b> · 대 ${fmt(projection.majorNv)} / 소 ${fmt(projection.minorNv)} → 상위 라인에 <b>${fmt(projection.completedNv)} NV</b> 반영 예정</p>`;
    const targetBox =
      node.depth === 0
        ? `<p class="help">최상위 목표 · 대 ${fmt(node.majorTarget)} / 소 ${fmt(node.minorTarget)} (위에서 직접 입력한 값)</p>`
        : `<div class="closing-target-edit" data-target-member="${safe(node.memberId)}"><span>이 사업자 마감 목표 ${node.overridden ? "<em>직접 입력함</em>" : "<em>자동 배분값</em>"}</span><label>라인 합계<input data-sub-target="line" type="number" min="0" step="1000" value="${node.lineTarget}" ${completion ? "disabled" : ""}></label><label>소실적 최소<input data-sub-target="floor" type="number" min="0" step="1000" value="${node.minorFloor}" ${completion ? "disabled" : ""}></label><button class="secondary compact" data-reset-target="${safe(node.memberId)}" type="button" ${node.overridden && !completion ? "" : "disabled"}>자동값으로</button><small>자동 배분값 라인 합계 ${fmt(node.autoLineTarget)} · 소실적 기준선 ${fmt(node.autoMinorFloor)}${node.autoMinorFloor > 0 ? " (인증직급 기준)" : " (인증직급이 없어 기준선 없음)"}${completion ? " · 마감을 취소해야 수정할 수 있습니다" : ""}</small></div>`;
    return `<section class="card closing-step" data-step-member="${safe(item.node.memberId)}"><div class="section-head"><h2>${title}</h2><b>${state}</b></div>${breadcrumb}${todoHtml}${targetBox}<div class="closing-lines">${lineHtml(item, 0)}${lineHtml(item, 1)}</div>${treeHtml(item)}${final}${payoutHtml(item, finalMinorNv, Boolean(completion))}${warn}${button}</section>`;
  };

  const runPlan = () => {
    $("perfError").textContent = "";
    plan.topMemberId = $("topMemberSelect").value;
    const topMajorInput = $("topMajor"),
      topMinorInput = $("topMinor");
    plan.topMajorTarget = Number(
      topMajorInput ? topMajorInput.value : plan.topMajorTarget,
    );
    plan.topMinorTarget = Number(
      topMinorInput ? topMinorInput.value : plan.topMinorTarget,
    );
    plan.closingMemberIds = [
      ...$("closingOptions").querySelectorAll("input:checked"),
    ].map((input) => input.value);
    if (!plan.closingMemberIds.includes(plan.topMemberId)) {
      plan.closingMemberIds.push(plan.topMemberId);
    }
    plan.targetOverrides = Object.fromEntries(
      Object.entries(plan.targetOverrides || {}).filter(([id]) =>
        plan.closingMemberIds.includes(String(id)),
      ),
    );
    lastSignature = planSignature(
      plan.topMemberId,
      { majorTarget: plan.topMajorTarget, minorTarget: plan.topMinorTarget },
      plan.closingMemberIds,
      plan.targetOverrides,
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
      const allocation = allocateClosingTargets(
        model,
        plan.topMemberId,
        { majorTarget: plan.topMajorTarget, minorTarget: plan.topMinorTarget },
        plan.closingMemberIds,
        plan.targetOverrides,
      );
      const nodes = flattenAllocation(allocation).sort(
        (left, right) => right.depth - left.depth,
      );
      items = nodes.map((node) => {
        if (!nodeHasTarget(node)) {
          return { node, skipped: true, completion: null };
        }
        const result = calculatePerformance(
          model,
          node.memberId,
          nodeTargets(node),
        );
        const projection = projectClosingCompletion(result);
        const completion = effectiveCompletion(node.memberId);
        if (completion) {
          applyClosingCompletion(model, node.memberId, completion);
        } else if (projection.feasible !== false) {
          applyClosingCompletion(model, node.memberId, projection);
        }
        return { node, result, projection, completion };
      });
      const nextIndex = items.findIndex(
        (item) => !item.completion && !item.skipped,
      );
      items.forEach((item, index) => {
        item.canComplete = index === nextIndex;
      });
      const topItem = items[items.length - 1];
      const topMajorNv = topItem.completion
        ? Number(topItem.completion.majorNv)
        : Number(topItem.projection?.majorNv || 0);
      const topMinorNv = topItem.completion
        ? Number(topItem.completion.minorNv)
        : Number(topItem.projection?.minorNv || 0);
      const placements = items.flatMap((item) =>
        item.skipped
          ? []
          : (item.projection.sales || []).map((sale) => ({
              closerMemberId: item.node.memberId,
              placementMemberId: sale.memberId || null,
              side: sale.side,
              salesWon: sale.salesWon,
              addedNv: sale.addedNv,
              excessNv: sale.excessNv,
            })),
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
      lastRun = {
        allocation,
        placements,
        topMajorNv,
        topMinorNv,
        topCompletedNv: topMajorNv + topMinorNv,
        verified,
      };
      const topMember = model.byId.get(plan.topMemberId);
      $("perfSummary").innerHTML =
        `<section class="recommend-card"><span>전체 계획 요약 · ${safe(topMember?.userName || "")} 기준</span><h2>추천 매출 합계 ${fmt(totalSalesWon)}원</h2><p>아직 넣지 않은 매출 ${fmt(remainingSalesWon)}원 · 매출 1,000원 = 810 NV · 최소 10,000원부터</p><p>최상위 예상 마감 · 대 ${fmt(topMajorNv)} / 소 ${fmt(topMinorNv)} (목표 대 ${fmt(plan.topMajorTarget)} / 소 ${fmt(plan.topMinorTarget)})</p><p><b>${verified ? "✅ 이대로 진행하면 목표를 채울 수 있습니다" : "⚠️ 지금 계획으로는 목표를 채우지 못합니다"}</b></p></section>`;
      $("perfResult").innerHTML = items
        .map((item, index) => stepHtml(item, index + 1, items.length))
        .join("");
      const activeItems = items.filter((item) => !item.skipped);
      $("stepTabs").hidden = !activeItems.length;
      $("stepTabs").innerHTML = activeItems
        .map((item) => {
          const memberName = model.byId.get(item.node.memberId)?.userName || "이름 없음";
          const saleTotal = (item.projection.sales || []).reduce(
            (sum, sale) => sum + Number(sale.salesWon || 0),
            0,
          );
          return `<button class="business-tab${saleTotal > 0 ? " sale" : ""}" data-step-tab="${safe(item.node.memberId)}" type="button">${safe(memberName)}${saleTotal > 0 ? ` · ${fmt(saleTotal)}원` : " · 달성"}</button>`;
        })
        .join("");
      $("stepTabs").querySelectorAll("[data-step-tab]").forEach(
        (tab) =>
          (tab.onclick = () => {
            $("stepTabs")
              .querySelectorAll("[data-step-tab]")
              .forEach((item) =>
                item.classList.toggle("active", item === tab),
              );
            navigateTree(tab.dataset.stepTab);
            $("closingMainTree").scrollIntoView({
              behavior: "smooth",
              block: "start",
            });
          }),
      );
      fitTrees();
      renderClosers();
      renderMainTree();
      renderBusinessTabs();
    } catch (calculationError) {
      $("perfError").textContent = calculationError.message;
      $("perfSummary").replaceChildren();
      $("perfResult").replaceChildren();
    }
  };

  $("treeBack").onclick = () => {
    if (!treeFocusHistory.length) return;
    treeFocusId = treeFocusHistory.pop();
    renderMainTree();
    renderBusinessTabs();
  };
  $("treeHome").onclick = () => {
    treeFocusHistory = [];
    navigateTree(plan.topMemberId);
  };
  $("treeZoomOut").onclick = () => setTreeZoom(treeZoom - 0.1);
  $("treeZoomIn").onclick = () => setTreeZoom(treeZoom + 0.1);
  $("treeZoomReset").onclick = () => setTreeZoom(1);
  {
    const canvas = $("closingMainTree");
    let panActive = false,
      panMoved = false,
      panCaptured = false,
      panStartX = 0,
      panStartY = 0,
      panScrollLeft = 0,
      panScrollTop = 0;
    canvas.onpointerdown = (event) => {
      if (event.button !== 0) return;
      panActive = true;
      panMoved = false;
      panStartX = event.clientX;
      panStartY = event.clientY;
      panScrollLeft = canvas.scrollLeft;
      panScrollTop = canvas.scrollTop;
    };
    canvas.onpointermove = (event) => {
      if (!panActive) return;
      const dx = event.clientX - panStartX,
        dy = event.clientY - panStartY;
      if (!panMoved && Math.abs(dx) + Math.abs(dy) > 6) {
        panMoved = true;
        panCaptured = true;
        canvas.classList.add("dragging");
        canvas.setPointerCapture(event.pointerId);
      }
      if (!panMoved) return;
      canvas.scrollLeft = panScrollLeft - dx;
      canvas.scrollTop = panScrollTop - dy;
    };
    const panStop = (event) => {
      panActive = false;
      canvas.classList.remove("dragging");
      if (panCaptured && canvas.hasPointerCapture(event.pointerId))
        canvas.releasePointerCapture(event.pointerId);
      panCaptured = false;
    };
    canvas.onpointerup = panStop;
    canvas.onpointercancel = panStop;
    canvas.addEventListener(
      "click",
      (event) => {
        if (!panMoved) return;
        event.preventDefault();
        event.stopPropagation();
        panMoved = false;
      },
      true,
    );
  }
  $("closingMainTree").addEventListener("click", (event) => {
    const hideTarget = event.target.closest("[data-hide-member]");
    if (hideTarget) {
      hiddenTreeIds.add(hideTarget.dataset.hideMember);
      saveHiddenTreeIds();
      renderMainTree({ preserveScroll: true });
      return;
    }
    const restoreTarget = event.target.closest("[data-restore-member]");
    if (restoreTarget) {
      hiddenTreeIds.delete(restoreTarget.dataset.restoreMember);
      saveHiddenTreeIds();
      renderMainTree({ preserveScroll: true });
      return;
    }
    const button = event.target.closest("[data-member]");
    if (!button) return;
    if (treeClickTimer) {
      clearTimeout(treeClickTimer);
      treeClickTimer = null;
      return;
    }
    treeClickTimer = setTimeout(() => {
      treeClickTimer = null;
      navigateTree(button.dataset.member);
    }, 260);
  });
  $("closingMainTree").addEventListener("dblclick", (event) => {
    if (event.target.closest("[data-hide-member], [data-restore-member]"))
      return;
    const button = event.target.closest("[data-member]");
    if (!button) return;
    if (treeClickTimer) {
      clearTimeout(treeClickTimer);
      treeClickTimer = null;
    }
    openTreeTarget(button.dataset.member);
  });
  $("treeToggleHidden").onclick = () => {
    showHiddenTree = !showHiddenTree;
    renderMainTree({ preserveScroll: true });
  };
  $("treeTargetClose").onclick = () => $("treeTargetDialog").close();
  $("treeTargetForm").onsubmit = async (event) => {
    event.preventDefault();
    const memberId = $("treeTargetDialog").dataset.member;
    const major = Number($("treeTargetMajor").value || 0);
    const minor = Number($("treeTargetMinor").value || 0);
    if (!plan.closingMemberIds.includes(memberId))
      plan.closingMemberIds.push(memberId);
    plan.targetOverrides = {
      ...plan.targetOverrides,
      [memberId]: { majorTarget: major, minorTarget: minor },
    };
    $("treeTargetDialog").close();
    // runPlan()이 체크박스 DOM 상태로 closingMemberIds를 덮어쓰기 때문에,
    // 방금 추가한 멤버의 체크박스를 먼저 다시 그려서 체크된 상태로
    // 만들어야 runPlan()에서 그대로 유지되고 방금 입력한 목표가 지워지지 않는다.
    renderClosers();
    runPlan();
    await persistPlan();
  };
  $("treeTargetReset").onclick = async () => {
    const memberId = $("treeTargetDialog").dataset.member;
    const { [memberId]: _removed, ...rest } = plan.targetOverrides || {};
    plan.targetOverrides = rest;
    $("treeTargetDialog").close();
    runPlan();
    await persistPlan();
  };
  $("topMemberSelect").onchange = () =>
    switchToTopMember($("topMemberSelect").value);
  const syncClosingSelection = () => {
    plan.closingMemberIds = [
      ...$("closingOptions").querySelectorAll("input:checked"),
    ].map((input) => input.value);
    if (!plan.closingMemberIds.includes(plan.topMemberId)) {
      plan.closingMemberIds.push(plan.topMemberId);
    }
    $("closingCount").textContent =
      `${plan.closingMemberIds.filter((id) => id !== plan.topMemberId).length}명`;
  };
  $("closingOptions").onchange = syncClosingSelection;
  $("closingOptions").onclick = (event) => {
    const name = event.target.closest("[data-toggle-group]")?.dataset.toggleGroup;
    if (!name) return;
    collapsedGroups.add(name);
    renderClosers();
  };
  $("closingCollapsedGroups").onclick = (event) => {
    const name = event.target.closest("[data-expand-group]")?.dataset.expandGroup;
    if (!name) return;
    collapsedGroups.delete(name);
    renderClosers();
  };
  $("closingFilter").oninput = () => {
    const query = $("closingFilter").value.trim().toLowerCase();
    let expanded = false;
    if (query) {
      for (const name of [...collapsedGroups]) {
        if (name.toLowerCase().includes(query)) {
          collapsedGroups.delete(name);
          expanded = true;
        }
      }
    }
    if (expanded) renderClosers();
    else applyClosingFilter();
  };
  $("closingShowSingles").onclick = () => {
    showSingles = !showSingles;
    renderClosers();
  };
  $("closingSelectAll").onclick = () => {
    $("closingOptions")
      .querySelectorAll("label:not([hidden]) input")
      .forEach((input) => (input.checked = true));
    syncClosingSelection();
  };
  $("closingSelectNone").onclick = () => {
    $("closingOptions")
      .querySelectorAll("label:not([hidden]) input")
      .forEach((input) => (input.checked = false));
    syncClosingSelection();
  };
  $("perfRun").onclick = async () => {
    runPlan();
    await persistPlan();
  };
  $("perfResult").addEventListener("toggle", fitTrees, true);
  window.addEventListener("resize", fitTrees);
  $("perfResult").onchange = async (event) => {
    const input = event.target.closest("[data-sub-target]");
    if (!input) return;
    const box = input.closest("[data-target-member]");
    const id = box.dataset.targetMember;
    const lineTarget = Number(box.querySelector('[data-sub-target="line"]').value);
    const minorFloor = Number(
      box.querySelector('[data-sub-target="floor"]').value,
    );
    if (!Number.isFinite(lineTarget) || !Number.isFinite(minorFloor)) return;
    plan.targetOverrides = {
      ...plan.targetOverrides,
      [id]: {
        lineTarget: Math.max(0, lineTarget),
        minorFloor: Math.max(0, minorFloor),
      },
    };
    const { [id]: _kept, ...restAcknowledged } = plan.acknowledged || {};
    plan.acknowledged = restAcknowledged;
    runPlan();
    await persistPlan();
  };
  $("perfResult").onclick = async (event) => {
    const completeButton = event.target.closest("[data-complete-closing]");
    const cancelButton = event.target.closest("[data-cancel-closing]");
    const resetButton = event.target.closest("[data-reset-target]");
    const keepButton = event.target.closest("[data-keep-target]");
    if (resetButton) {
      const { [resetButton.dataset.resetTarget]: _removed, ...rest } =
        plan.targetOverrides || {};
      plan.targetOverrides = rest;
      runPlan();
      await persistPlan();
      return;
    }
    if (keepButton) {
      const id = keepButton.dataset.keepTarget;
      const acknowledged = { ...(plan.acknowledged || {}) };
      if (acknowledged[id]) delete acknowledged[id];
      else acknowledged[id] = new Date().toISOString();
      plan.acknowledged = acknowledged;
      runPlan();
      await persistPlan();
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

  try {
    const memberIds = model.rows.map((row) => String(row.userId));
    const { data: selfRows, error: selfError } = await supabase.rpc(
      "get_self_closings",
      { p_member_ids: memberIds },
    );
    if (!selfError && selfRows) {
      selfClosings = Object.fromEntries(
        selfRows.map((row) => [
          String(row.member_no),
          {
            majorNv: Number(row.major_nv),
            minorNv: Number(row.minor_nv),
            completedNv: Number(row.completed_nv),
            completedAt: row.completed_at,
            external: true,
          },
        ]),
      );
    }
  } catch {}
  const selfClosedDescendantIds = new Set(
    descendantsOf(plan.topMemberId).map((row) => String(row.userId)),
  );
  Object.keys(selfClosings).forEach((id) => {
    if (selfClosedDescendantIds.has(id) && !plan.closingMemberIds.includes(id)) {
      plan.closingMemberIds.push(id);
    }
  });

  renderControls();
  runPlan();
}
