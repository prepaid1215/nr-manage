export function localDate(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function monthRange(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month));
  if (!match) throw new Error("월은 YYYY-MM 형식이어야 합니다.");

  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) {
    throw new Error("월은 1~12 사이여야 합니다.");
  }

  const lastDay = new Date(year, monthNumber, 0).getDate();
  return {
    start: `${match[1]}-${match[2]}-01`,
    end: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`,
  };
}
