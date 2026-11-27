import { supabase } from "./supabase.js?v=20260829-34";
import { EDUCATION_TRACKS } from "./education-data.js?v=20261127-1";

// 교육 탭: 초기 사업자 가이드.
//  - 완료 체크는 계정(DB)에 저장하고, 서버를 못 쓸 때는 이 기기에만 저장한다. 계보 위쪽 계정이 볼 수 있다(RUN_055).
//  - 교육 내용은 기본 데이터(education-data.js)를 쓰다가, 관리자가 편집해 저장하면 서버 내용을 쓴다(RUN_056).
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 저장이 막힌 환경에서는 이번 화면에서만 유지된다 */
  }
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const itemsOf = (tracks) => tracks.flatMap((t) => t.groups.flatMap((g) => g.items));
const itemIds = (track) => track.groups.flatMap((g) => g.items.map((i) => i.id));

// 사진은 긴 변 1600px, JPEG로 줄여서 올린다.
async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("사진을 변환하지 못했어요."))), "image/jpeg", 0.82),
  );
}

export function educationPage(root, me) {
  const doneKey = `edu-done-v1:${me?.id || "guest"}`;
  const trackKey = `edu-track-v1:${me?.id || "guest"}`;
  let done = read(doneKey, {});
  if (!done || typeof done !== "object" || Array.isArray(done)) done = {};
  let tracks = clone(EDUCATION_TRACKS);
  let activeId = read(trackKey, tracks[0].id);
  let dbOk = false;
  let isAdmin = false;
  let editing = false;
  let draft = null; // 편집 중인 사본(저장하기 전까지 화면에만 있다)
  let downline = [];
  let saveNote = "";
  let editNote = "";

  const view = () => (editing ? draft : tracks);
  const doneCount = (ids) => ids.filter((id) => done[id]).length;

  async function saveRemote(id, checked) {
    if (!dbOk || !me?.id) return;
    const result = checked
      ? await supabase.from("nrc_education_progress").upsert({ owner_id: me.id, item_id: String(id) }, { onConflict: "owner_id,item_id" })
      : await supabase.from("nrc_education_progress").delete().eq("owner_id", me.id).eq("item_id", String(id));
    saveNote = result.error ? "서버에 저장하지 못했어요. 이 기기에는 저장됐어요." : "";
    const note = root.querySelector(".edu-save-note");
    if (note) note.textContent = saveNote;
  }

  async function loadRemote() {
    if (!me?.id) return;
    // 서버에 저장된 교육 내용과 관리자 여부 (RUN_056 적용 전이면 기본 내용을 그대로 쓴다)
    const [content, admin] = await Promise.all([
      supabase.from("nrc_education_content").select("content").eq("id", "main").maybeSingle(),
      supabase.rpc("is_app_admin"),
    ]);
    if (!content.error && Array.isArray(content.data?.content?.tracks) && content.data.content.tracks.length) {
      tracks = content.data.content.tracks;
    }
    isAdmin = !content.error && !admin.error && Boolean(admin.data);
    if (!tracks.some((t) => t.id === activeId)) activeId = tracks[0].id;

    const mine = await supabase.from("nrc_education_progress").select("item_id").eq("owner_id", me.id);
    if (!mine.error) {
      dbOk = true;
      const remote = new Set((mine.data || []).map((row) => String(row.item_id)));
      // 예전에 이 기기에만 체크해 둔 항목은 서버로 올리고, 서버 값과 합친다.
      const localOnly = Object.keys(done).filter((id) => done[id] && !remote.has(String(id)));
      if (localOnly.length) {
        await supabase
          .from("nrc_education_progress")
          .upsert(localOnly.map((id) => ({ owner_id: me.id, item_id: String(id) })), { onConflict: "owner_id,item_id" });
      }
      const merged = {};
      for (const id of remote) merged[id] = true;
      for (const id of localOnly) merged[id] = true;
      done = merged;
      write(doneKey, done);
      const below = await supabase.rpc("get_downline_education_progress");
      downline = below.error ? [] : below.data || [];
    }
    if (!editing) render();
  }

  function downlinePanel() {
    if (!downline.length) return "";
    const all = itemsOf(tracks);
    const titleById = new Map(all.map((i) => [String(i.id), i.title]));
    const rows = downline
      .map((m) => {
        const ids = new Set((m.done_ids || []).map(String));
        const perTrack = tracks
          .map((t) => {
            const list = itemIds(t);
            const lines = t.groups
              .flatMap((g) => g.items)
              .map((i) => `<li class="${ids.has(String(i.id)) ? "ok" : ""}">${ids.has(String(i.id)) ? "✓" : "○"} ${esc(titleById.get(String(i.id)))}</li>`)
              .join("");
            return `<div class="edu-member-track"><b>${esc(t.icon)} ${esc(t.title)}</b> <small>${list.filter((id) => ids.has(String(id))).length} / ${list.length}</small><ul>${lines}</ul></div>`;
          })
          .join("");
        const last = m.last_done_at ? String(m.last_done_at).slice(0, 10) : "-";
        const countNow = all.filter((i) => ids.has(String(i.id))).length;
        return `<details class="edu-member"><summary><span class="edu-member-name">${esc(m.member_name)}</span><small>${esc(m.member_no)}</small><b>${countNow} / ${all.length}</b><small>최근 ${esc(last)}</small></summary>${perTrack}</details>`;
      })
      .join("");
    return `<section class="card edu-downline"><h2>내 아래 사람 교육 진행</h2><p class="help">내 NRC 계보 아래에 있는 사람의 완료 현황이에요. 아래에서 위로는 보이지 않아요.</p>${rows}</section>`;
  }

  const photosHtml = (item) =>
    (item.photos || [])
      .map((p) => `<figure class="edu-photo"><img src="${esc(p.url)}" alt="${esc(p.caption || item.title)}" loading="lazy">${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ""}</figure>`)
      .join("");

  function itemView(item) {
    const example = item.example ? `<div class="edu-example"><span>참고</span>${esc(item.example)}</div>` : "";
    const tag = item.tag ? `<em class="edu-tag">${esc(item.tag)}</em>` : "";
    const summary = item.summary ? `<p class="edu-summary">${esc(item.summary)}</p>` : "";
    const body = item.body ? `<div class="edu-body">${esc(item.body)}</div>` : `<p class="help">아직 작성된 내용이 없어요.</p>`;
    return `<details class="edu-item${done[item.id] ? " done" : ""}">
      <summary>
        <input type="checkbox" class="edu-check" data-id="${item.id}"${done[item.id] ? " checked" : ""} aria-label="${esc(item.title)} 완료 표시">
        <span class="edu-item-title">${esc(item.title)}</span>${tag}
      </summary>
      <div class="edu-item-body">${summary}${body}${photosHtml(item)}${example}</div>
    </details>`;
  }

  function itemEdit(item, gi) {
    const photos = (item.photos || [])
      .map(
        (p, pi) => `<div class="edu-photo-edit"><img src="${esc(p.url)}" alt=""><input type="text" data-photo-caption="${pi}" value="${esc(p.caption || "")}" placeholder="사진 설명"><button type="button" class="secondary compact" data-photo-del="${pi}">삭제</button></div>`,
      )
      .join("");
    return `<div class="edu-edit-item" data-edit-id="${item.id}" data-gi="${gi}">
      <label>제목<input type="text" data-f="title" value="${esc(item.title)}"></label>
      <label>내용<textarea data-f="body" rows="6">${esc(item.body)}</textarea></label>
      <label>참고(예시)<textarea data-f="example" rows="2">${esc(item.example || "")}</textarea></label>
      <div class="edu-photos-edit">${photos}</div>
      <div class="edu-edit-actions">
        <label class="secondary compact edu-file">사진 추가<input type="file" accept="image/*" data-photo-add hidden></label>
        <button type="button" class="secondary compact edu-danger" data-item-del>항목 삭제</button>
      </div>
    </div>`;
  }

  function render() {
    const list = view();
    const track = list.find((t) => t.id === activeId) || list[0];
    const everything = itemsOf(list);
    const total = everything.length;
    const all = doneCount(everything.map((i) => i.id));
    const pct = total ? Math.round((all / total) * 100) : 0;
    const trackButtons = list
      .map((t) => {
        const ids = itemIds(t);
        return `<button type="button" class="edu-track${t.id === track.id ? " active" : ""}" data-track="${esc(t.id)}">
          <span class="edu-track-icon">${esc(t.icon)}</span><b>${esc(t.title)}</b><small>${doneCount(ids)} / ${ids.length}개 완료</small></button>`;
      })
      .join("");
    const groups = track.groups
      .map((g, gi) => {
        const body = editing
          ? g.items.map((item) => itemEdit(item, gi)).join("") + `<button type="button" class="secondary compact" data-item-add="${gi}">＋ 항목 추가</button>`
          : g.items.map(itemView).join("");
        return `<section class="edu-group">
          <div class="edu-group-head"><span class="edu-step">${track.groups.length > 1 ? `STEP ${String(gi + 1).padStart(2, "0")}` : "과정"}</span>
            <div><h3>${esc(g.name)}</h3>${g.desc ? `<p class="help">${esc(g.desc)}</p>` : ""}</div>
            <small class="edu-group-count">${doneCount(g.items.map((i) => i.id))} / ${g.items.length}</small></div>
          ${body}
        </section>`;
      })
      .join("");
    const adminBar = isAdmin
      ? editing
        ? `<div class="edu-admin-bar"><b>교육 내용 편집 중</b><span>저장하기 전에는 다른 사람에게 보이지 않아요.</span><button type="button" class="primary compact" data-edit-save>저장</button><button type="button" class="secondary compact" data-edit-cancel>취소</button></div>`
        : `<div class="edu-admin-bar"><span>관리자</span><button type="button" class="secondary compact" data-edit-start>✎ 교육 내용 편집</button></div>`
      : "";
    root.innerHTML = `${adminBar}${editNote ? `<p class="error edu-edit-note">${esc(editNote)}</p>` : ""}
      <section class="card edu-hero">
        <span class="eyebrow">BUSINESS TRAINING</span>
        <h2>초기 사업자 성장 가이드</h2>
        <p>하나씩 따라 하면, 준비 완료.</p>
        <div class="edu-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
        <small>${all} / ${total}개 완료 · ${pct}%</small>
      </section>
      <div class="edu-tracks">${trackButtons}</div>
      <h2 class="edu-track-title">${esc(track.icon)} ${esc(track.title)}</h2>
      ${groups}
      <p class="help edu-note">${dbOk ? "완료 표시는 내 계정에 저장되고, 내 계보 위쪽 계정이 볼 수 있어요." : "완료 표시는 이 기기에만 저장돼요."} <span class="edu-save-note">${esc(saveNote)}</span></p>
      ${editing ? "" : downlinePanel()}`;
    bind(track);
  }

  // 편집 중 입력값을 draft에 옮겨 둔다(화면을 다시 그리기 전에 호출).
  function syncDraft(track) {
    root.querySelectorAll(".edu-edit-item").forEach((box) => {
      const group = track.groups[Number(box.dataset.gi)];
      const item = group?.items.find((i) => String(i.id) === box.dataset.editId);
      if (!item) return;
      box.querySelectorAll("[data-f]").forEach((field) => (item[field.dataset.f] = field.value));
      box.querySelectorAll("[data-photo-caption]").forEach((field) => {
        const photo = item.photos?.[Number(field.dataset.photoCaption)];
        if (photo) photo.caption = field.value;
      });
    });
  }

  function bind(track) {
    root.querySelectorAll("[data-track]").forEach((button) => {
      button.onclick = () => {
        if (editing) syncDraft(track);
        activeId = button.dataset.track;
        write(trackKey, activeId);
        render();
      };
    });
    root.querySelectorAll(".edu-check").forEach((box) => {
      // 체크 칸을 눌러도 항목이 접히거나 펼쳐지지 않게 한다.
      box.addEventListener("click", (event) => event.stopPropagation());
      box.onchange = () => {
        const id = box.dataset.id;
        if (box.checked) done[id] = true;
        else delete done[id];
        write(doneKey, done);
        saveRemote(id, box.checked);
        const open = [...root.querySelectorAll("details.edu-item[open] .edu-check")].map((c) => c.dataset.id);
        render();
        root.querySelectorAll(".edu-check").forEach((c) => {
          if (open.includes(c.dataset.id)) c.closest("details").open = true;
        });
      };
    });
    const start = root.querySelector("[data-edit-start]");
    if (start)
      start.onclick = () => {
        draft = clone(tracks);
        editing = true;
        editNote = "";
        render();
      };
    const cancel = root.querySelector("[data-edit-cancel]");
    if (cancel)
      cancel.onclick = () => {
        if (!confirm("편집한 내용을 버릴까요?")) return;
        editing = false;
        draft = null;
        editNote = "";
        render();
      };
    const save = root.querySelector("[data-edit-save]");
    if (save)
      save.onclick = async () => {
        syncDraft(track);
        save.disabled = true;
        const { error } = await supabase
          .from("nrc_education_content")
          .upsert({ id: "main", content: { tracks: draft }, updated_by: me.id, updated_at: new Date().toISOString() }, { onConflict: "id" });
        if (error) {
          editNote = `저장하지 못했어요: ${error.message}`;
          render();
          return;
        }
        tracks = clone(draft);
        editing = false;
        draft = null;
        editNote = "";
        render();
      };
    if (!editing) return;
    root.querySelectorAll("[data-item-add]").forEach((button) => {
      button.onclick = () => {
        syncDraft(track);
        const next = Math.max(0, ...itemsOf(draft).map((i) => Number(i.id) || 0)) + 1;
        track.groups[Number(button.dataset.itemAdd)].items.push({ id: next, title: "새 항목", body: "" });
        render();
      };
    });
    root.querySelectorAll(".edu-edit-item").forEach((box) => {
      const group = track.groups[Number(box.dataset.gi)];
      const item = group.items.find((i) => String(i.id) === box.dataset.editId);
      box.querySelector("[data-item-del]").onclick = () => {
        if (!confirm(`‘${item.title}’ 항목을 삭제할까요? 저장하면 완료 기록도 더는 보이지 않아요.`)) return;
        syncDraft(track);
        group.items = group.items.filter((i) => i !== item);
        render();
      };
      box.querySelectorAll("[data-photo-del]").forEach((button) => {
        button.onclick = () => {
          syncDraft(track);
          item.photos.splice(Number(button.dataset.photoDel), 1);
          render();
        };
      });
      box.querySelector("[data-photo-add]").onchange = async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        syncDraft(track);
        try {
          const blob = await shrinkPhoto(file);
          const path = `photos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
          const up = await supabase.storage.from("education").upload(path, blob, { contentType: "image/jpeg" });
          if (up.error) throw up.error;
          const url = supabase.storage.from("education").getPublicUrl(path).data.publicUrl;
          item.photos = [...(item.photos || []), { url, caption: "" }];
          editNote = "";
        } catch (error) {
          editNote = `사진을 올리지 못했어요: ${error.message || error}`;
        }
        render();
      };
    });
  }

  render();
  loadRemote();
}
