import { supabase } from "./supabase.js?v=20260829-34";
import { friendlyError } from "./errors.js?v=20260830-1";
import { buildPerformanceModel } from "./performance-calculator.js?v=20260831-61";

const resources = [
  ["customers", "고객"],
  ["activity", "활동"],
  ["checklist", "체크리스트"],
  ["performance", "실적"],
  ["organization_summary", "조직"],
  ["commission", "수당"],
  ["closing_sales", "마감매출"],
];
const safe = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

export async function teamPage(root, me) {
  root.innerHTML = `<section class="card"><h2>팀 관리</h2><p class="help">회원코드를 정확히 검색한 뒤 이름을 확인하고 파트너로 임명할 수 있습니다.</p><form id="teamCreate" class="inline-form"><input id="teamName" placeholder="팀 이름" required><button class="primary">팀 만들기</button></form><div id="teamError" class="error"></div></section><div id="teamList"></div>`;
  const $ = (id) => document.getElementById(id),
    errorBox = $("teamError");
  const explainError = (error) =>
    /function .* does not exist|schema cache/i.test(error.message)
      ? "Supabase에서 RUN_011_PARTNER_CODE_APPOINTMENT.sql을 먼저 실행하세요."
      : friendlyError(error);

  // 회원코드로 파트너를 임명하기 전에, 실적 탭에서 이미 수집해둔 내 계보도
  // 데이터와 대조해서 그 사람이 실제로 내 하위인지 상위인지 확인한다.
  // 계보도 수집이 안 돼 있거나 그 관계가 안 잡히면 "확인 불가"로 두고
  // 예전처럼 그대로 진행할 수 있게 한다(차단하지 않음).
  let genealogyModel = null,
    genealogyLoadTried = false;
  async function loadMyGenealogyModel() {
    if (genealogyModel || genealogyLoadTried) return genealogyModel;
    genealogyLoadTried = true;
    try {
      const { data } = await supabase
        .from("nrc_sync_snapshots")
        .select("payload")
        .eq("owner_id", me.id)
        .eq("snapshot_type", "combined")
        .order("collected_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!data) return null;
      const payload =
        typeof data.payload === "string" ? JSON.parse(data.payload) : data.payload;
      genealogyModel = buildPerformanceModel(payload);
    } catch {
      genealogyModel = null;
    }
    return genealogyModel;
  }
  const isAncestor = (model, startId, targetId) => {
    let current = model.byId.get(String(startId));
    const visited = new Set();
    while (current?.ppId && !visited.has(String(current.ppId))) {
      visited.add(String(current.ppId));
      if (String(current.ppId) === String(targetId)) return true;
      current = model.byId.get(String(current.ppId));
    }
    return false;
  };
  async function checkGenealogyRelation(memberNo) {
    const model = await loadMyGenealogyModel();
    const myId = String(me.member_no || "");
    if (!model || !myId || !model.byId.has(myId) || !model.byId.has(String(memberNo)))
      return "unknown";
    if (isAncestor(model, memberNo, myId)) return "downline";
    if (isAncestor(model, myId, memberNo)) return "upline";
    return "unrelated";
  }

  async function load() {
    errorBox.textContent = "";
    const [teamsResult, rolesResult] = await Promise.all([
      supabase.from("teams").select("*").order("created_at"),
      supabase
        .from("team_members")
        .select("team_id,role")
        .eq("user_id", me.id)
        .eq("active", true),
    ]);
    if (teamsResult.error || rolesResult.error) {
      errorBox.textContent = (teamsResult.error || rolesResult.error).message;
      return;
    }
    const teams = teamsResult.data || [],
      roles = new Map(
        (rolesResult.data || []).map((row) => [row.team_id, row.role]),
      );
    $("teamList").innerHTML = teams.length
      ? teams
          .map((team) => {
            const role =
                team.owner_id === me.id
                  ? "OWNER"
                  : roles.get(team.id) || "MEMBER",
              canManage = role === "OWNER" || role === "MANAGER";
            return `<section class="card team-card"><div class="section-head"><div><h2>${safe(team.name)}</h2><small>${safe(team.id)}</small></div><b>${role === "OWNER" ? "팀장" : role === "MANAGER" ? "관리자" : "파트너"}</b></div>${canManage ? `<form data-find-partner="${team.id}" class="partner-search"><label>하위 회원코드<input name="memberNo" inputmode="numeric" pattern="[0-9]+" placeholder="회원코드를 정확히 입력" required></label><button class="secondary" type="submit">코드 검색</button></form><div class="partner-result" data-partner-result="${team.id}"></div>` : ""}${role === "OWNER" ? `<form data-share="${team.id}" class="share-form"><select name="viewer" required><option value="">권한을 받을 파트너 선택</option></select><div class="share-resource-grid">${resources.map(([value, label]) => `<label class="check compact"><input type="checkbox" name="resource" value="${value}"> ${label}</label>`).join("")}</div><label class="check"><input name="write" type="checkbox"> 수정도 허용</label><button class="secondary">공유 권한 추가</button></form><h3 class="team-member-title">공유 권한 목록</h3><div data-grants="${team.id}" class="grant-list"></div>` : ""}<h3 class="team-member-title">팀 구성원</h3><div data-members="${team.id}" class="team-members"></div><div data-team-status="${team.id}" class="connection-status" hidden></div></section>`;
          })
          .join("")
      : '<section class="card"><p class="help">가입한 팀이 없습니다.</p></section>';

    root.querySelectorAll("[data-find-partner]").forEach(
      (form) =>
        (form.onsubmit = async (event) => {
          event.preventDefault();
          errorBox.textContent = "";
          const teamId = form.dataset.findPartner,
            memberNo = form.memberNo.value.trim(),
            box = root.querySelector(`[data-partner-result="${teamId}"]`),
            { data, error } = await supabase.rpc("find_partner_by_member_no", {
              p_team_id: teamId,
              p_member_no: memberNo,
            });
          if (error) {
            errorBox.textContent = explainError(error);
            return;
          }
          const partner = data?.[0];
          if (!partner) {
            box.innerHTML = '<p class="error">일치하는 가입 회원이 없습니다.</p>';
            return;
          }
          box.innerHTML = `<article><div><b>${safe(partner.partner_name)}</b><small>회원코드 ${safe(partner.masked_member_no)}</small></div><small data-relation-note="${teamId}">계보도 확인 중...</small>${partner.already_member ? '<strong class="partner-appointed">이미 등록된 파트너</strong>' : `<button class="primary compact" data-appoint="${teamId}" data-code="${safe(memberNo)}" type="button">파트너 임명</button>`}</article>`;
          box
            .querySelector("[data-appoint]")
            ?.addEventListener("click", appointPartner);
          if (!partner.already_member) {
            const relation = await checkGenealogyRelation(memberNo);
            const note = box.querySelector("[data-relation-note]");
            const appointButton = box.querySelector("[data-appoint]");
            if (note) {
              if (relation === "downline") {
                note.textContent = "✅ 계보도 확인됨 · 내 하위 사업자입니다.";
                note.className = "relation-ok";
              } else if (relation === "upline") {
                note.textContent = "⚠️ 계보도상 이 사람은 내 상위입니다. 상위를 내 하위 파트너로 등록하면 안 됩니다.";
                note.className = "relation-warn";
                if (appointButton) {
                  appointButton.disabled = true;
                  appointButton.textContent = "상위라 임명 불가";
                }
              } else if (relation === "unrelated") {
                note.textContent = "❔ 계보도에서 하위로 확인되지 않았습니다. 회원코드가 맞는지, 또는 계보 수집 중간에 빠진 사업자가 있어 연결이 끊긴 건 아닌지 확인해보세요. (막지는 않으니 확실하면 그대로 임명하셔도 됩니다)";
                note.className = "relation-warn";
              } else {
                note.textContent = "계보도 데이터가 없어 관계를 확인하지 못했습니다(실적 탭에서 먼저 수집하면 확인됩니다).";
                note.className = "relation-unknown";
              }
            }
          } else {
            const note = box.querySelector("[data-relation-note]");
            if (note) note.remove();
          }
        }),
    );
    root.querySelectorAll("[data-share]").forEach(
      (form) =>
        (form.onsubmit = async (event) => {
          event.preventDefault();
          const teamId = form.dataset.share,
            selectedResources = [...form.querySelectorAll('[name="resource"]:checked')].map(
              (input) => input.value,
            );
          if (!selectedResources.length) {
            errorBox.textContent = "공유할 자료를 하나 이상 선택하세요.";
            return;
          }
          const { error } = await supabase.from("sharing_grants").upsert(
            selectedResources.map((resource) => ({
              team_id: teamId,
              viewer_id: form.viewer.value,
              owner_id: me.id,
              resource,
              can_read: true,
              can_write: form.write.checked,
              created_by: me.id,
            })),
            { onConflict: "team_id,viewer_id,owner_id,resource" },
          );
          if (error) errorBox.textContent = friendlyError(error);
          else {
            const status = root.querySelector(`[data-team-status="${teamId}"]`);
            status.hidden = false;
            status.textContent = `자료 공유 권한 ${selectedResources.length}건을 저장했습니다.`;
            form.querySelectorAll('[name="resource"]').forEach((input) => (input.checked = false));
            await loadGrants(teamId);
          }
        }),
    );
    for (const team of teams) await loadMembers(team.id);
    for (const team of teams)
      if (team.owner_id === me.id) await loadGrants(team.id);
  }

  const resourceLabel = (value) =>
    resources.find(([key]) => key === value)?.[1] || value;

  async function loadGrants(teamId) {
    const box = root.querySelector(`[data-grants="${teamId}"]`);
    if (!box) return;
    const [grantsResult, membersResult] = await Promise.all([
      supabase
        .from("sharing_grants")
        .select("id,viewer_id,resource,can_write")
        .eq("team_id", teamId)
        .eq("owner_id", me.id),
      supabase.rpc("list_team_partners", { p_team_id: teamId }),
    ]);
    if (grantsResult.error) {
      box.innerHTML = `<p class="error">${safe(friendlyError(grantsResult.error))}</p>`;
      return;
    }
    const nameByViewer = new Map(
      (membersResult.data || []).map((member) => [
        member.user_id,
        member.partner_name,
      ]),
    );
    const grants = grantsResult.data || [];
    box.innerHTML = grants.length
      ? grants
          .map(
            (grant) =>
              `<article class="grant-item"><div><b>${safe(nameByViewer.get(grant.viewer_id) || "알 수 없음")}</b><small>${safe(resourceLabel(grant.resource))} · ${grant.can_write ? "읽기+수정" : "읽기만"}</small></div><button class="grant-revoke" data-revoke-grant="${grant.id}" type="button">취소</button></article>`,
          )
          .join("")
      : '<p class="help">공유한 권한이 없습니다.</p>';
    box.querySelectorAll("[data-revoke-grant]").forEach(
      (button) =>
        (button.onclick = async () => {
          if (!confirm("이 공유 권한을 취소할까요?")) return;
          const { error } = await supabase
            .from("sharing_grants")
            .delete()
            .eq("id", button.dataset.revokeGrant);
          if (error) errorBox.textContent = friendlyError(error);
          else await loadGrants(teamId);
        }),
    );
  }

  async function appointPartner(event) {
    const button = event.currentTarget;
    if (button.disabled) return;
    const relation = await checkGenealogyRelation(button.dataset.code);
    if (
      relation === "upline" &&
      !confirm(
        "계보도상 이 사람은 내 상위로 확인됩니다. 그래도 파트너로 임명할까요?",
      )
    )
      return;
    const { data, error } = await supabase.rpc("appoint_partner_by_member_no", {
        p_team_id: button.dataset.appoint,
        p_member_no: button.dataset.code,
      });
    if (error) {
      errorBox.textContent = explainError(error);
      return;
    }
    const partner = data?.[0];
    await load();
    const status = root.querySelector(
      `[data-team-status="${button.dataset.appoint}"]`,
    );
    if (status) {
      status.hidden = false;
      status.textContent = `${partner?.partner_name || "회원"}님을 파트너로 임명했습니다.`;
    }
  }

  async function loadMembers(teamId) {
    const { data, error } = await supabase.rpc("list_team_partners", {
      p_team_id: teamId,
    });
    if (error) {
      errorBox.textContent = explainError(error);
      return;
    }
    const members = data || [],
      box = root.querySelector(`[data-members="${teamId}"]`),
      share = root.querySelector(
        `[data-share="${teamId}"] select[name="viewer"]`,
      );
    if (box)
      box.innerHTML = members
        .map(
          (member) =>
            `<span><b>${safe(member.partner_name)}</b> ${safe(member.masked_member_no)} · ${safe(member.partner_role)}</span>`,
        )
        .join("");
    if (share)
      share.innerHTML =
        '<option value="">권한을 받을 파트너 선택</option>' +
        members
          .filter((member) => member.user_id !== me.id)
          .map(
            (member) =>
              `<option value="${member.user_id}">${safe(member.partner_name)} · ${safe(member.masked_member_no)}</option>`,
          )
          .join("");
  }

  $("teamCreate").onsubmit = async (event) => {
    event.preventDefault();
    const { data, error } = await supabase
      .from("teams")
      .insert({ name: $("teamName").value.trim(), owner_id: me.id })
      .select()
      .single();
    if (error) {
      errorBox.textContent = friendlyError(error);
      return;
    }
    const result = await supabase.from("team_members").insert({
      team_id: data.id,
      user_id: me.id,
      role: "OWNER",
      active: true,
    });
    if (result.error) errorBox.textContent = friendlyError(result.error);
    else load();
  };
  await load();
}
