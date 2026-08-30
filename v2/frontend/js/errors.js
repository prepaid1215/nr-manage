const text = (error) => String(error?.message || error || "").trim();

export function friendlyError(error, fallback = "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.") {
  const message = text(error);
  if (!message) return fallback;

  const rules = [
    [/invalid login credentials|invalid_credentials/i, "아이디 또는 비밀번호가 올바르지 않습니다."],
    [/email not confirmed/i, "가입 확인이 완료되지 않았습니다. 관리자에게 문의해 주세요."],
    [/user already registered|already been registered/i, "이미 사용 중인 아이디입니다."],
    [/password should be at least|weak_password/i, "비밀번호는 8자 이상 입력해 주세요."],
    [/rate limit|too many requests|over_email_send_rate_limit/i, "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."],
    [/failed to fetch|networkerror|network request failed|load failed|fetch.*failed/i, "인터넷 연결을 확인한 뒤 다시 시도해 주세요."],
    [/jwt expired|token.*expired|refresh_token_not_found|invalid refresh token/i, "로그인 시간이 만료되었습니다. 다시 로그인해 주세요."],
    [/permission denied|row-level security|violates row.level security|42501/i, "이 항목을 보거나 수정할 권한이 없습니다."],
    [/duplicate key|23505/i, "이미 등록된 정보입니다. 기존 항목을 확인해 주세요."],
    [/foreign key|23503/i, "연결된 정보가 있어 처리할 수 없습니다."],
    [/not.null constraint|23502/i, "필수 정보가 빠졌습니다. 입력 내용을 확인해 주세요."],
    [/invalid input syntax|22P02/i, "입력 형식이 올바르지 않습니다."],
    [/statement timeout|timeout|timed out|57014/i, "처리 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요."],
    [/schema cache|could not find the .* in the schema|PGRST\d+/i, "서비스 설정을 확인하는 중입니다. 계속되면 관리자에게 문의해 주세요."],
    [/function .* does not exist/i, "필요한 서버 기능이 아직 준비되지 않았습니다. 관리자에게 문의해 주세요."],
    [/relation .* does not exist|column .* does not exist/i, "서비스 업데이트가 아직 완료되지 않았습니다. 관리자에게 문의해 주세요."],
    [/not found|404/i, "요청한 정보를 찾지 못했습니다."],
    [/service unavailable|bad gateway|gateway timeout|\b50[234]\b/i, "서버가 잠시 응답하지 않습니다. 잠시 후 다시 시도해 주세요."],
  ];
  return rules.find(([pattern]) => pattern.test(message))?.[1] ||
    (/^[\x00-\x7F]+$/.test(message) ? fallback : message);
}
