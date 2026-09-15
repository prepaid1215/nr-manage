const $ = (id) => document.getElementById(id);

function setStatus(message, isError = false) {
  const status = $("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function readPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return { title: "", selection: "" };
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        title: document.title || "",
        selection: window.getSelection ? String(window.getSelection()) : "",
      }),
    });
    return result || { title: "", selection: "" };
  } catch {
    // 크롬 내부 페이지(chrome://) 등 스크립트 주입이 안 되는 곳
    return { title: tab.title || "", selection: "" };
  }
}

async function copyText(text, label) {
  if (!text.trim()) {
    setStatus(`복사할 ${label}이(가) 없습니다.`, true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text.trim());
    setStatus(`${label}을(를) 복사했습니다.`);
  } catch {
    setStatus("클립보드 복사에 실패했습니다. 직접 선택해 복사해 주세요.", true);
  }
}

(async () => {
  const { title, selection } = await readPage();
  $("titleText").value = title;
  $("selectionText").value = selection;
})();

$("copyTitle").onclick = () => copyText($("titleText").value, "제목");
$("copySelection").onclick = () => copyText($("selectionText").value, "선택한 텍스트");
