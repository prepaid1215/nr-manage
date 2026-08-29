import { supabase } from "./supabase.js?v=20260829-11";
const groups = [
  [
    "마케팅",
    "초기 세팅",
    [
      "영업용 번호 생성",
      "영업용 계정 생성",
      "상호명 정하기",
      "카카오채널·네이버톡톡 생성",
      "지도등록",
      "앤스마트 발급",
      "아이홀7 세팅",
      "앤플랫폼 세팅",
    ],
  ],
  [
    "마케팅",
    "블로그",
    [
      "ID 3개 생성",
      "전북국 20개 채우기",
      "북불용 이미지 만들기",
      "제목 30개 만들기",
      "선불폰 포스팅 30개",
      "매일 포스팅 7개 기록",
    ],
  ],
  [
    "개통우대",
    "사전 준비",
    [
      "앤플랫폼 바로알기",
      "꼭 알아야할 통신지식",
      "상담부터 개통까지",
      "앤플랫폼 활용방법",
      "선불시장 강의 시청",
    ],
  ],
  [
    "개통우대",
    "센터개통",
    [
      "센터 주소·전화·팩스 확인",
      "고객 예약증 만들기",
      "센터 팩스 양식 저축",
      "회사 홈페이지에서 회선 체크",
    ],
  ],
  ["보상플랜", "배우기", ["보상플랜 기초", "보상플랜 심화"]],
  [
    "보상플랜",
    "준비",
    ["가족계좌 1~2개 가입", "본인·가족계좌 ID/PW 확인", "가족계좌 GD 만들기"],
  ],
  [
    "보상플랜",
    "실습",
    [
      "하위 매출 보는 법",
      "NRC PAY 충전 방법",
      "원하는 매출에 요금 충전",
      "매 마감차 20/20",
      "매 마감차 40/40",
      "매 마감차 80/80",
      "매 마감차 160/160",
      "매 마감차 320/320",
    ],
  ],
];
export const checklistItemCount = groups.reduce(
  (sum, [, , items]) => sum + items.length,
  0,
);
const key = (g, s, item) => `${g}|${s}|${item}`;
export async function checklistPage(root, me) {
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>성장 체크리스트</h2><p class="help">카테고리를 눌러 항목과 메모를 작성하세요.</p></div><b id="checkPercent">0%</b></div><div class="progress"><i id="checkBar"></i></div><p id="checkCount" class="help"></p></section><div id="checkGroups">${groups.map(([g, s, items], index) => `<details class="card checklist-group" data-check-group="${index}"><summary><span><small>${g}</small><b>${s}</b></span><strong class="check-group-progress">0/${items.length} · 0%</strong></summary><div class="checklist-items">${items.map((item) => `<article data-key="${key(g, s, item)}"><label class="check"><input type="checkbox"><b>${item}</b></label><input class="check-memo" placeholder="메모 / 관련 자료 / 궁금한 점"></article>`).join("")}</div></details>`).join("")}</div><button id="saveChecklist" class="primary">체크리스트 저장</button><div id="checkStatus" class="connection-status" hidden></div><div id="checkError" class="error"></div>`;
  const $ = (id) => document.getElementById(id),
    articles = [...root.querySelectorAll("[data-key]")],
    progress = () => {
      const done = articles.filter(
          (a) => a.querySelector("[type=checkbox]").checked,
        ).length,
        pct = Math.round((done / articles.length) * 100);
      $("checkPercent").textContent = `${pct}%`;
      $("checkBar").style.width = `${pct}%`;
      $("checkCount").textContent = `${done} / ${articles.length}개 완료`;
      articles.forEach((a) =>
        a.classList.toggle("done", a.querySelector("[type=checkbox]").checked),
      );
      root.querySelectorAll("[data-check-group]").forEach((group) => {
        const rows = [...group.querySelectorAll("[data-key]")],
          groupDone = rows.filter(
            (row) => row.querySelector("[type=checkbox]").checked,
          ).length,
          groupPct = Math.round((groupDone / rows.length) * 100);
        group.querySelector(".check-group-progress").textContent =
          `${groupDone}/${rows.length} · ${groupPct}%`;
      });
    };
  const { data, error } = await supabase
    .from("checklist_progress")
    .select("*")
    .eq("owner_id", me.id);
  if (error) $("checkError").textContent = error.message;
  else {
    const map = new Map((data || []).map((row) => [row.item_key, row]));
    articles.forEach((a) => {
      const row = map.get(a.dataset.key);
      a.querySelector("[type=checkbox]").checked = !!row?.checked;
      a.querySelector(".check-memo").value = row?.memo || "";
    });
  }
  articles.forEach(
    (a) => (a.querySelector("[type=checkbox]").onchange = progress),
  );
  progress();
  $("saveChecklist").onclick = async () => {
    const values = articles.map((a) => ({
        owner_id: me.id,
        item_key: a.dataset.key,
        checked: a.querySelector("[type=checkbox]").checked,
        memo: a.querySelector(".check-memo").value || null,
        updated_at: new Date().toISOString(),
      })),
      { error } = await supabase
        .from("checklist_progress")
        .upsert(values, { onConflict: "owner_id,item_key" });
    if (error) $("checkError").textContent = error.message;
    else {
      $("checkStatus").hidden = false;
      $("checkStatus").textContent = "체크리스트를 저장했습니다.";
    }
  };
}
