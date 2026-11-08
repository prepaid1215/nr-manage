import { supabase } from "./supabase.js?v=20260829-34";

const BASE = "https://nrc-sync-cloud-sg.onrender.com/account-recovery";
export const QUESTIONS = [
  ["secret_word", "나만 아는 비밀 단어는?"],
  ["memory_place", "나만 기억하는 특별한 장소는?"],
  ["nickname", "나만 알고 있는 별명은?"],
];
const $ = (id) => document.getElementById(id);
const options = () => '<option value="">질문 선택</option>' + QUESTIONS.map(([value, text]) => `<option value="${value}">${text}</option>`).join("");
const answerHint = "답은 2~128자입니다. 앞뒤 공백·연속 공백·영문 대소문자는 구분하지 않습니다.";

export function readQuiz(question, answer, confirmation) {
  if (!QUESTIONS.some(([id]) => id === question)) throw Error("복구 질문을 선택하세요.");
  const normalized = answer.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length < 2 || normalized.length > 128) throw Error("퀴즈 답을 2~128자로 입력하세요.");
  if (answer !== confirmation) throw Error("퀴즈 답과 확인 입력이 일치하지 않습니다.");
  return { question, answer };
}

export async function recoveryRequest(path, data, authenticated = false) {
  const headers = { "Content-Type": "application/json" };
  if (authenticated) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw Error("다시 로그인해 주세요.");
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  let response;
  try {
    response = await fetch(BASE + path, {
      method: data === undefined ? "GET" : "POST", headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(90000), cache: "no-store",
    });
  } catch {
    throw Error("계정 복구 서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok)
    throw Error(result.message || "계정 복구 기능을 사용할 수 없습니다. 관리자에게 문의하세요.");
  return result;
}

export function installRecoveryUi() {
  const signup = document.createElement("div");
  signup.innerHTML = `<label class="signup-only" hidden>계정 복구 질문<select id="signupQuestion">${options()}</select></label><label class="signup-only" hidden>퀴즈 답<input id="signupAnswer" type="password" minlength="2" maxlength="128" autocomplete="off"><small class="help">${answerHint} 다른 사람이 추측하기 어려운 답을 정하세요.</small></label><label class="signup-only" hidden>퀴즈 답 확인<input id="signupAnswerConfirm" type="password" minlength="2" maxlength="128" autocomplete="off"></label>`;
  $("signupMemberNo").closest("label").after(signup);
  const buttons = document.createElement("div");
  buttons.className = "recovery-links";
  buttons.innerHTML = '<button type="button" class="link-button" id="findUsername">아이디 찾기</button><button type="button" class="link-button" id="findPassword">비밀번호 재설정</button>';
  $("authModeBtn").after(buttons);
  const dialog = document.createElement("dialog");
  dialog.id = "recoveryDialog";
  dialog.className = "customer-dialog small recovery-dialog";
  dialog.setAttribute("aria-labelledby", "recoveryTitle");
  dialog.innerHTML = `<form id="recoveryForm"><div class="dialog-head"><h2 id="recoveryTitle">아이디 찾기</h2><button type="button" id="recoveryClose" aria-label="닫기">×</button></div><p class="help">가입할 때 등록한 정보와 퀴즈 답을 입력하세요. 퀴즈를 등록하지 않았다면 관리자에게 초기화를 요청하세요.</p><label id="recoveryNameLabel">이름<input id="recoveryName" minlength="2" maxlength="40" autocomplete="name"></label><label id="recoveryUsernameLabel">아이디<input id="recoveryUsername" minlength="4" maxlength="30" pattern="[A-Za-z0-9._-]+" autocomplete="username"></label><label>회원번호<input id="recoveryMemberNo" inputmode="numeric" pattern="[0-9]{4,20}" required></label><label>등록한 질문<select id="recoveryQuestion" required>${options()}</select></label><label>퀴즈 답<input id="recoveryAnswer" type="password" minlength="2" maxlength="128" autocomplete="off" required><small class="help">${answerHint}</small></label><label id="recoveryPasswordLabel">새 비밀번호<input id="recoveryPassword" type="password" minlength="8" maxlength="72" autocomplete="new-password"></label><label id="recoveryConfirmLabel">새 비밀번호 확인<input id="recoveryPasswordConfirm" type="password" minlength="8" maxlength="72" autocomplete="new-password"></label><p class="error" id="recoveryError" role="alert"></p><p class="connection-status" id="recoveryResult" role="status" hidden></p><div class="customer-actions"><button type="button" class="secondary" id="recoveryCancel">닫기</button><button type="submit" class="primary" id="recoverySubmit">아이디 찾기</button></div></form>`;
  document.body.append(dialog);
  let mode = "username";
  const open = (nextMode) => {
    mode = nextMode;
    $("recoveryForm").reset();
    $("recoveryError").textContent = "";
    $("recoveryResult").hidden = true;
    const password = mode === "password";
    $("recoveryTitle").textContent = password ? "비밀번호 재설정" : "아이디 찾기";
    $("recoverySubmit").textContent = $("recoveryTitle").textContent;
    for (const [label, input, visible] of [
      ["recoveryNameLabel", "recoveryName", !password],
      ["recoveryUsernameLabel", "recoveryUsername", password],
      ["recoveryPasswordLabel", "recoveryPassword", password],
      ["recoveryConfirmLabel", "recoveryPasswordConfirm", password],
    ]) {
      $(label).hidden = !visible;
      $(input).required = visible;
      $(input).disabled = !visible;
    }
    dialog.showModal();
  };
  $("findUsername").onclick = () => open("username");
  $("findPassword").onclick = () => open("password");
  $("recoveryClose").onclick = $("recoveryCancel").onclick = () => dialog.close();
  dialog.addEventListener("close", () => { $("recoveryForm").reset(); });
  $("recoveryForm").onsubmit = async (event) => {
    event.preventDefault();
    const button = $("recoverySubmit");
    $("recoveryError").textContent = "";
    $("recoveryResult").hidden = true;
    if (mode === "password" && $("recoveryPassword").value !== $("recoveryPasswordConfirm").value) {
      $("recoveryError").textContent = "새 비밀번호가 서로 일치하지 않습니다.";
      return;
    }
    button.disabled = true;
    try {
      const result = await recoveryRequest("/recover", {
        mode, name: $("recoveryName").value.trim(), username: $("recoveryUsername").value.trim(),
        memberNo: $("recoveryMemberNo").value.trim(), question: $("recoveryQuestion").value,
        answer: $("recoveryAnswer").value,
        ...(mode === "password" ? { newPassword: $("recoveryPassword").value } : {}),
      });
      $("recoveryResult").textContent = mode === "username"
        ? `가입한 아이디는 ${result.username}입니다.`
        : "비밀번호를 변경했습니다. 새 비밀번호로 로그인하세요.";
      $("recoveryResult").hidden = false;
      if (mode === "username") $("loginUsername").value = result.username;
      else $("loginUsername").value = $("recoveryUsername").value.trim();
      for (const id of ["recoveryAnswer", "recoveryPassword", "recoveryPasswordConfirm", "loginPassword"]) $(id).value = "";
    } catch (error) {
      $("recoveryError").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}

export function signupQuiz() {
  return readQuiz($("signupQuestion").value, $("signupAnswer").value, $("signupAnswerConfirm").value);
}

export async function saveSignupQuiz(quiz, password) {
  try {
    await recoveryRequest("/quiz", { ...quiz, currentPassword: password }, true);
    return null;
  } catch {
    // The account already exists at this point; do not turn this into a misleading signup failure.
    return "가입은 완료됐지만 복구 퀴즈를 저장하지 못했습니다. 설정 → 계정에서 다시 등록해 주세요.";
  } finally {
    $("signupAnswer").value = $("signupAnswerConfirm").value = "";
  }
}

export function mountRecoverySettings(root) {
  const section = document.createElement("div");
  section.className = "recovery-settings";
  section.innerHTML = `<h3>아이디·비밀번호 복구 퀴즈</h3><p class="help" id="quizState" role="status">등록 상태 확인 중...</p><form id="quizSettingsForm"><label>현재 비밀번호<input id="quizCurrentPassword" type="password" maxlength="128" autocomplete="current-password" required></label><label>질문<select id="quizQuestion" required>${options()}</select></label><label>새 퀴즈 답<input id="quizAnswer" type="password" minlength="2" maxlength="128" autocomplete="off" required><small class="help">${answerHint} 다른 사람이 추측하기 어려운 답을 정하세요.</small></label><label>퀴즈 답 확인<input id="quizAnswerConfirm" type="password" minlength="2" maxlength="128" autocomplete="off" required></label><button type="submit" class="primary" id="quizSave">복구 퀴즈 저장</button><p class="error" id="quizSettingsError" role="alert"></p></form>`;
  root.append(section);
  void recoveryRequest("/quiz", undefined, true).then((result) => {
    if (!section.isConnected) return;
    $("quizState").textContent = result.configured ? "복구 퀴즈가 등록되어 있습니다. 답을 바꾸려면 새로 저장하세요." : "아직 복구 퀴즈가 없습니다. 로그인할 수 있을 때 미리 등록하세요.";
    if (result.question) $("quizQuestion").value = result.question;
  }).catch((error) => {
    if (section.isConnected) $("quizState").textContent = error.message;
  });
  $("quizSettingsForm").onsubmit = async (event) => {
    event.preventDefault();
    $("quizSettingsError").textContent = "";
    $("quizSave").disabled = true;
    try {
      const quiz = readQuiz($("quizQuestion").value, $("quizAnswer").value, $("quizAnswerConfirm").value);
      await recoveryRequest("/quiz", { ...quiz, currentPassword: $("quizCurrentPassword").value }, true);
      if (!section.isConnected) return;
      $("quizState").textContent = "복구 퀴즈를 저장했습니다.";
      $("quizSettingsForm").reset();
    } catch (error) {
      if (section.isConnected) $("quizSettingsError").textContent = error.message;
    } finally {
      if (section.isConnected) $("quizSave").disabled = false;
    }
  };
}

export async function enforcePasswordChange(onDone) {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) throw error;
  if (!user?.app_metadata?.recovery_password_required) return false;
  const previous = $("passwordChangeDialog");
  if (previous) previous.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "passwordChangeDialog";
  dialog.className = "customer-dialog small recovery-dialog";
  dialog.setAttribute("aria-labelledby", "passwordChangeTitle");
  dialog.innerHTML = `<form id="passwordChangeForm"><div class="dialog-head"><h2 id="passwordChangeTitle">새 비밀번호 설정</h2></div><p class="help">관리자가 비밀번호를 초기화했습니다. 임시 비밀번호를 새 비밀번호로 바꾼 후 이용하세요.</p><label>임시 비밀번호<input id="temporaryPassword" type="password" autocomplete="current-password" required></label><label>새 비밀번호<input id="requiredNewPassword" type="password" minlength="8" maxlength="72" autocomplete="new-password" required></label><label>새 비밀번호 확인<input id="requiredPasswordConfirm" type="password" minlength="8" maxlength="72" autocomplete="new-password" required></label><p class="error" id="passwordChangeError" role="alert"></p><div class="customer-actions"><button type="button" class="secondary" id="passwordChangeLogout">로그아웃</button><button type="submit" class="primary" id="passwordChangeSubmit">변경 후 로그인</button></div></form>`;
  document.body.append(dialog);
  $("appView").hidden = true;
  $("loginView").hidden = false;
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  const finish = async (message) => {
    await supabase.auth.signOut({ scope: "local" });
    dialog.close();
    dialog.remove();
    $("loginPassword").value = "";
    onDone();
    $("loginError").textContent = message;
  };
  $("passwordChangeLogout").onclick = () => finish("");
  $("passwordChangeForm").onsubmit = async (event) => {
    event.preventDefault();
    $("passwordChangeError").textContent = "";
    if ($("requiredNewPassword").value !== $("requiredPasswordConfirm").value) {
      $("passwordChangeError").textContent = "새 비밀번호가 서로 일치하지 않습니다.";
      return;
    }
    $("passwordChangeSubmit").disabled = true;
    try {
      await recoveryRequest("/change-password", {
        currentPassword: $("temporaryPassword").value, newPassword: $("requiredNewPassword").value,
      }, true);
      await finish("비밀번호를 변경했습니다. 새 비밀번호로 로그인하세요.");
    } catch (error) {
      $("passwordChangeError").textContent = error.message;
    } finally {
      if ($("passwordChangeSubmit")) $("passwordChangeSubmit").disabled = false;
    }
  };
  dialog.showModal();
  return true;
}

export function installAdminPasswordReset(root) {
  const dialog = document.createElement("dialog");
  dialog.className = "customer-dialog small recovery-dialog";
  dialog.setAttribute("aria-labelledby", "adminResetTitle");
  dialog.innerHTML = `<form id="adminResetForm"><div class="dialog-head"><h2 id="adminResetTitle">비밀번호 초기화</h2><button type="button" id="adminResetClose" aria-label="닫기">×</button></div><p id="adminResetTarget"></p><p class="help">회원의 본인 여부를 확인한 뒤 초기화하세요. 임시 비밀번호를 발급하며, 회원은 다음 로그인에서 새 비밀번호를 설정합니다.</p><label id="adminResetPasswordLabel">관리자 본인의 비밀번호<input id="adminResetCurrentPassword" type="password" maxlength="128" autocomplete="current-password" required></label><p class="error" id="adminResetError" role="alert"></p><div class="temporary-password" id="adminResetResult" hidden><p>임시 비밀번호는 이 창에서 한 번만 확인할 수 있습니다. 회원에게 직접 전달하세요.</p><label>임시 비밀번호<input id="adminTemporaryPassword" readonly autocomplete="off"></label><button type="button" class="secondary" id="adminResetCopy">복사</button><p id="adminResetCopyStatus" role="status"></p></div><div class="customer-actions"><button type="button" class="secondary" id="adminResetCancel">닫기</button><button type="submit" class="primary" id="adminResetSubmit">임시 비밀번호 발급</button></div></form>`;
  root.append(dialog);
  let target;
  let pending = false;
  const clearSecrets = () => {
    dialog.querySelector("form").reset();
    target = null;
  };
  const close = () => {
    if (!pending) {
      clearSecrets();
      dialog.close();
    }
  };
  $("adminResetClose").onclick = $("adminResetCancel").onclick = close;
  dialog.addEventListener("cancel", (event) => {
    if (pending) event.preventDefault();
    else clearSecrets();
  });
  dialog.addEventListener("close", clearSecrets);
  $("adminResetCopy").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("adminTemporaryPassword").value);
      $("adminResetCopyStatus").textContent = "복사했습니다.";
    } catch {
      $("adminResetCopyStatus").textContent = "복사하지 못했습니다. 임시 비밀번호를 선택해 직접 복사하세요.";
    }
  };
  $("adminResetForm").onsubmit = async (event) => {
    event.preventDefault();
    if (pending || $("adminResetSubmit").hidden) return;
    pending = true;
    $("adminResetSubmit").disabled = true;
    $("adminResetClose").disabled = $("adminResetCancel").disabled = true;
    $("adminResetError").textContent = "";
    try {
      const result = await recoveryRequest("/admin-reset", {
        userId: target.user_id, currentPassword: $("adminResetCurrentPassword").value,
      }, true);
      if (!dialog.isConnected) return;
      $("adminResetCurrentPassword").value = "";
      $("adminResetCurrentPassword").required = false;
      $("adminResetPasswordLabel").hidden = true;
      $("adminTemporaryPassword").value = result.temporaryPassword;
      $("adminResetResult").hidden = false;
      $("adminResetSubmit").hidden = true;
    } catch (error) {
      if (dialog.isConnected) $("adminResetError").textContent = error.message;
    } finally {
      pending = false;
      if (dialog.isConnected) {
        $("adminResetSubmit").disabled = false;
        $("adminResetClose").disabled = $("adminResetCancel").disabled = false;
      }
    }
  };
  return (user) => {
    target = user;
    $("adminResetForm").reset();
    $("adminResetTarget").textContent = `${user.name || "이름 없음"} · ${user.username || "아이디 없음"} · ${user.member_no || "회원번호 없음"}`;
    $("adminResetCurrentPassword").required = true;
    $("adminResetPasswordLabel").hidden = false;
    $("adminResetResult").hidden = true;
    $("adminResetSubmit").hidden = false;
    $("adminResetError").textContent = $("adminResetCopyStatus").textContent = "";
    dialog.showModal();
  };
}
