// 교육 탭: 초기 사업자 성장 가이드(V98) 페이지를 원본 그대로 넣는다.
// 원본은 education/index.html 하나이고 파일은 고치지 않는다. 이 탭은 그 페이지를 화면 안에 띄우고,
// 원본이 자체로 가진 왼쪽 메뉴는 숨긴 뒤, 관리프로그램 왼쪽 메뉴의 "교육" 아래 하위 메뉴로 대신 조작한다.
// 원본의 체크·편집 내용은 이 브라우저(localStorage)에 저장된다.
export const EDU_SUB = [
  ["marketing", "📚 사업자 · 마케팅"],
  ["telecom", "📱 통신 실무 교육"],
  ["reward", "🎁 보상플랜 교육"],
  ["admin", "⚙ 관리 도구"],
  ["trash", "♻ 휴지통"],
];

const frame = () => document.querySelector(".edu-frame");

// 하위 메뉴 버튼 묶음(왼쪽 메뉴용 / 모바일 칩 줄용)
export const eduSubHtml = (cls) =>
  `<div class="${cls}">${EDU_SUB.map(([id, label]) => `<button type="button" class="edu-sub-btn" data-edu="${id}">${label}</button>`).join("")}</div>`;

// 원본 안에서 지금 보이는 화면: 'admin' | 'trash' | 교육 과정 id
function currentView() {
  try {
    const win = frame()?.contentWindow;
    if (!win) return "";
    const view = win.eval("typeof view==='string'?view:''");
    if (view === "admin" || view === "trash") return view;
    return win.eval("typeof activeTrack==='string'?activeTrack:''");
  } catch {
    return "";
  }
}

function markActive() {
  const now = currentView();
  document.querySelectorAll(".edu-sub-btn").forEach((b) => b.classList.toggle("active", b.dataset.edu === now));
}

export function educationGo(kind) {
  const el = frame();
  const win = el?.contentWindow;
  if (!win || typeof win.selectTrack !== "function") return;
  if (kind === "admin") win.showAdmin();
  else if (kind === "trash") win.showTrash();
  else win.selectTrack(kind);
  markActive();
}

let timer = null;
export function educationPage(root) {
  root.innerHTML =
    eduSubHtml("edu-subbar") +
    '<iframe class="edu-frame" src="./education/index.html?v=20261127-1" title="초기 사업자 성장 가이드"></iframe>';
  root.querySelectorAll("[data-edu]").forEach((b) => (b.onclick = () => educationGo(b.dataset.edu)));
  const el = frame();
  // 원본의 왼쪽 메뉴 영역만 숨긴다(원본 파일은 그대로, 보이는 모양만 바꾼다).
  el.addEventListener("load", () => {
    try {
      const style = el.contentDocument.createElement("style");
      style.textContent =
        "aside{display:none!important}.layout{display:block!important}main{max-width:none!important;padding-top:24px!important}";
      el.contentDocument.head.appendChild(style);
    } catch {
      /* 같은 사이트가 아니면 건너뛴다 */
    }
    markActive();
  });
  clearInterval(timer);
  // 원본 안에서 과정 카드를 눌러 화면이 바뀌어도 하위 메뉴 강조가 따라가게 한다.
  timer = setInterval(() => {
    if (!frame()) {
      clearInterval(timer);
      timer = null;
      return;
    }
    markActive();
  }, 600);
}
