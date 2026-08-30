import { supabase } from "./supabase.js?v=20260829-34";

const APP_VERSION = "20260830-1";
let userId = null;
let currentPage = null;

export function setTelemetryUser(id) {
  userId = id || null;
}

export function setTelemetryPage(page) {
  currentPage = page || null;
}

export function trackEvent(eventType, action = null, detail = {}) {
  if (!userId || !supabase) return;
  const safeDetail = Object.fromEntries(
    Object.entries(detail || {})
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 10),
  );
  void supabase
    .from("app_events")
    .insert({
      user_id: userId,
      event_type: String(eventType).slice(0, 60),
      page: currentPage ? String(currentPage).slice(0, 60) : null,
      action: action ? String(action).slice(0, 100) : null,
      detail: safeDetail,
      app_version: APP_VERSION,
    })
    .then(({ error }) => {
      if (error && !/app_events|schema cache|does not exist/i.test(error.message))
        console.warn("사용 기록 저장 실패", error);
    });
}

export function installInteractionTracking() {
  document.addEventListener("click", (event) => {
    const target = event.target.closest("button,[data-page],[data-view]");
    if (!target) return;
    const action = target.dataset.completeClosing !== undefined
      ? "complete_closing"
      : target.dataset.cancelClosing !== undefined
        ? "cancel_closing"
        : target.id ||
          target.dataset.page ||
          target.dataset.view ||
          target.dataset.settingsView ||
          target.dataset.closingView;
    if (action) trackEvent("action", action);
  });
  document.addEventListener("submit", (event) => {
    const action = event.target.id || "form";
    trackEvent("submit", action);
  });
  window.addEventListener("error", (event) => {
    trackEvent("error", "javascript_error", { name: event.error?.name || "Error" });
  });
  window.addEventListener("unhandledrejection", (event) => {
    trackEvent("error", "unhandled_promise", { name: event.reason?.name || "Error" });
  });
}
