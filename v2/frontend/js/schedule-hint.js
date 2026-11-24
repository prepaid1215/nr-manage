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
