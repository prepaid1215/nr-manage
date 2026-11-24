// 기록 탭 표는 일일 예약의 저녁 수집(18:00~23:59)과 마감일 예약의 새벽 수집(00:00~05:59)만 기록으로 쓴다.
// 다른 시간으로도 저장할 수 있고(사용자 선택 우선), 기록에 쓰이는 시간인지만 안내한다.
export const SCHEDULE_WINDOWS = {
  daily: { from: "18:00", to: "23:59", label: "저녁 6시~자정", use: "그날의 일반 기록(표의 날짜 칸)" },
  closing: { from: "00:00", to: "05:59", label: "새벽 0~6시", use: '마감일 아래 "최종마감" 기록' },
};

export function scheduleTimeNote(frequency, time) {
  const rule = SCHEDULE_WINDOWS[frequency];
  if (!time) return { text: "", warn: false };
  if (!rule) {
    return {
      text: "기록 탭 표에는 일일 예약의 저녁 6시~자정 수집과 마감일 예약의 새벽 0~6시 수집만 기록으로 쓰입니다.",
      warn: false,
    };
  }
  if (time >= rule.from && time <= rule.to) return { text: `✓ ${rule.label}에 수집하므로 ${rule.use}으로 쓰입니다.`, warn: false };
  return {
    text: `이 시간은 기록 표에 쓰이지 않습니다. ${rule.use}은(는) ${rule.label}에 마지막으로 수집한 값을 씁니다. 다른 용도라면 이대로 저장해도 됩니다.`,
    warn: true,
  };
}

// 기록용 기본 예약: 일일 22:00(저녁 구간) + 마감일 00:10(마감 다음날 새벽 구간).
// 이미 같은 용도의 예약(같은 계정, 같은 시간대 안)이 있으면 만들지 않는다.
export const RECORD_SCHEDULE_DEFAULTS = [
  { kind: "daily", label: "일일 기록 22시", run_time: "22:00", frequency: "daily", weekday: null, month_days: [] },
  { kind: "closing", label: "마감일 00:10", run_time: "00:10", frequency: "monthly", weekday: null, month_days: [1, 9, 16, 24] },
];

function sameClosingDays(days) {
  const set = [...new Set(days || [])].sort((a, b) => a - b);
  return set.length === 4 && [1, 9, 16, 24].every((day, i) => set[i] === day);
}

function hasRecordSchedule(existing, accountId, spec) {
  const rule = SCHEDULE_WINDOWS[spec.kind];
  return (existing || []).some((item) => {
    if (item.enabled === false || item.source_account_id !== accountId) return false;
    const time = String(item.run_time || "").slice(0, 5);
    if (time < rule.from || time > rule.to) return false;
    if (spec.kind === "daily") return item.frequency === "daily";
    return item.frequency === "monthly" && sameClosingDays(item.month_days);
  });
}

export function missingRecordSchedules(existing, accountId) {
  return RECORD_SCHEDULE_DEFAULTS.filter((spec) => !hasRecordSchedule(existing, accountId, spec));
}

// 저장된 예약이 안내 규칙의 어느 종류(daily/closing/그 밖)인지 알려 준다.
export function scheduleKind(item) {
  if (item.frequency === "monthly" && sameClosingDays(item.month_days)) return "closing";
  return item.frequency;
}
