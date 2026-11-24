// 차수 마감일: 8일 · 15일 · 23일 · 말일
export function closingRound(dateText) {
  const [year, month, day] = String(dateText || "").split("-").map(Number);
  if (!year || !month || !day) return 0;
  const lastDay = new Date(year, month, 0).getDate();
  if (day === 8) return 1;
  if (day === 15) return 2;
  if (day === 23) return 3;
  if (day === lastDay) return 4;
  return 0;
}

// 전날(이전 기록일) 대비 증감을 코드 단위로 붙인다. 이전 값이 없으면 null.
export function withDeltas(rows, previousRows) {
  const before = new Map((previousRows || []).map((row) => [String(row.user_id), row]));
  const diff = (now, old) => (now == null || old == null ? null : Number(now) - Number(old));
  return rows.map((row) => {
    const old = before.get(String(row.user_id));
    return {
      ...row,
      d_max: old ? diff(row.max_pv, old.max_pv) : null,
      d_min: old ? diff(row.min_pv, old.min_pv) : null,
      d_real: old ? diff(row.real_lines, old.real_lines) : null,
    };
  });
}

const csvCell = (value) => {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// 한 사람은 본코드와 바로 뒤 두 번호(서브1·서브2) 3개 코드다(이름이 같고 번호가 이어짐).
// 기록 표에는 계보 구조가 없어서 번호와 이름으로 묶는다. 묶이지 않는 코드는 "단독".
export function labelCodes(rows) {
  const byId = new Map(rows.map((row) => [String(row.user_id), row]));
  const labels = new Map();
  const ids = [...byId.keys()].sort((a, b) => Number(a) - Number(b));
  for (const id of ids) {
    if (labels.has(id)) continue;
    const a = String(Number(id) + 1);
    const b = String(Number(id) + 2);
    const name = byId.get(id).user_name;
    if (byId.has(a) && byId.has(b) && !labels.has(a) && !labels.has(b) && name && byId.get(a).user_name === name && byId.get(b).user_name === name) {
      labels.set(id, "본");
      labels.set(a, "서브1");
      labels.set(b, "서브2");
    }
  }
  for (const id of ids) if (!labels.has(id)) labels.set(id, "단독");
  return labels;
}

// 코드별 줄을 사람 단위(본·서브1·서브2)로 묶는다. 묶이지 않는 코드는 singles에 둔다.
export function groupPeople(rows) {
  const labels = labelCodes(rows);
  const byId = new Map(rows.map((row) => [String(row.user_id), row]));
  const people = [];
  const singles = [];
  for (const row of rows) {
    const id = String(row.user_id);
    const label = labels.get(id);
    if (label === "본") {
      people.push({ code: id, name: row.user_name, rank: row.rank_name, main: row, s1: byId.get(String(Number(id) + 1)), s2: byId.get(String(Number(id) + 2)) });
    } else if (label === "단독") {
      singles.push(row);
    }
  }
  return { people, singles };
}

export const personValue = (obj, path) => path.split(".").reduce((value, key) => (value == null ? value : value[key]), obj);

// 한 사람이 한 줄: 서브1·서브2 각각의 대실적·소실적·회선수와 이전 기록일 대비 증감.
// 본코드 칸은 항상 포함하고(엑셀에서 숨기면 됨), 묶이지 않은 단독 코드는 본코드 칸에 넣는다.
export function toPeopleCsv(people, singles, date, account) {
  const part = (row) => (row ? [row.user_id, row.max_pv, row.min_pv, row.real_lines] : ["", "", "", ""]);
  const delta = (row) => (row ? [row.d_max, row.d_min, row.d_real] : ["", "", ""]);
  const header = [
    "날짜", "계정", "이름", "직급", "형태",
    "본코드", "본대실적", "본소실적", "본회선",
    "서브1코드", "서브1대실적", "서브1소실적", "서브1회선",
    "서브2코드", "서브2대실적", "서브2소실적", "서브2회선",
    "서브1대실적증감", "서브1소실적증감", "서브1회선증감",
    "서브2대실적증감", "서브2소실적증감", "서브2회선증감",
  ];
  const blank = (count) => Array(count).fill("");
  const lines = [
    ...people.map((p) => [date, account, p.name, p.rank, "사람", ...part(p.main), ...part(p.s1), ...part(p.s2), ...delta(p.s1), ...delta(p.s2)]),
    ...singles.map((row) => [date, account, row.user_name, row.rank_name, "단독코드", ...part(row), ...blank(14)]),
  ].map((cells) => cells.map(csvCell).join(","));
  return "\uFEFF" + [header.join(","), ...lines].join("\r\n");
}

// ---- 날짜별 보기(사람마다 서브1·서브2 두 칸, 세로는 날짜) ----
export const GRID_METRICS = [
  ["total", "총실적 (본인+대+소)"],
  ["max_pv", "대실적"],
  ["min_pv", "소실적"],
  ["real_lines", "회선수"],
];

export function monthDates(monthText) {
  const [year, month] = String(monthText || "").split("-").map(Number);
  if (!year || !month) return [];
  const last = new Date(year, month, 0).getDate();
  return Array.from({ length: last }, (_, i) => `${year}-${String(month).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`);
}

// 값이 없으면 null(수집 안 됨). 실제 0은 0으로 둔다.
export function gridValue(row, metric) {
  if (!row) return null;
  if (metric === "total") return Number(row.ord_pv || 0) + Number(row.max_pv || 0) + Number(row.min_pv || 0);
  const value = row[metric];
  return value == null ? null : Number(value);
}

// people: [{ code, name, s1, s2 }] (s1·s2는 코드 번호 문자열). rows: 기록 줄들.
// 결과: 날짜마다 { date, round, cells: [사람1 서브1, 사람1 서브2, 사람2 서브1, ...] }
export function nextDate(dateText) {
  const [year, month, day] = String(dateText).split("-").map(Number);
  const next = new Date(year, month - 1, day + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}

// 마감일 줄 바로 아래에 "최종마감N차" 줄(final: true)을 하나 더 둔다.
// 최종마감 값은 마감일이 지나고 자정 뒤에 저장된 다음날 0시 기록이다. 그 기록이 없으면 null.
export function buildGrid(rows, people, dates, metric) {
  const byKey = new Map(rows.map((row) => [`${row.metric_date}|${row.user_id}`, row]));
  const cellsOn = (date) => people.flatMap((p) => [p.s1, p.s2].map((code) => gridValue(code ? byKey.get(`${date}|${code}`) : null, metric)));
  return dates.flatMap((date) => {
    const round = closingRound(date);
    const line = { date, round, cells: cellsOn(date) };
    return round ? [line, { date, round, final: true, cells: cellsOn(nextDate(date)) }] : [line];
  });
}

export function toGridCsv(grid, people, metricLabel) {
  const header = ["날짜", "마감", ...people.flatMap((p) => [`${p.name || p.code} 서브1 ${metricLabel}`, `${p.name || p.code} 서브2 ${metricLabel}`])];
  const lines = grid.map((row) => [row.date, row.final ? `최종마감${row.round}차` : row.round ? `${row.round}차 마감` : "", ...row.cells].map(csvCell).join(","));
  return "\uFEFF" + [header.map(csvCell).join(","), ...lines].join("\r\n");
}

// 이름·코드를 입력해 사람을 찾는다. 정확히 같은 이름/코드/"이름 (코드)"가 있으면 그것만, 없으면 일부 일치로 찾는다.
export function matchPeople(people, text) {
  const query = String(text || "").trim().toLowerCase();
  if (!query) return [];
  const name = (p) => String(p.name || p.code || "").toLowerCase();
  const label = (p) => `${name(p)} (${p.code})`;
  const exact = people.filter((p) => label(p) === query || name(p) === query || String(p.code) === query);
  if (exact.length) return exact;
  return people.filter((p) => label(p).includes(query));
}

// 표에 등록한 사람(nrc_tracked_members)을 기록 목록의 '사람'과 같은 모양으로 만든다.
// 등록한 뒤 기록이 쌓이기 전에도 표에 열이 보이도록 한다. knownCodes: 이미 기록에서 묶인 본코드 번호 집합(중복 방지).
// 서브가 없는 단독 코드는 서브1 열 하나로 보여 준다.
export function trackedPeople(tracked, knownCodes = new Set()) {
  const groups = new Map();
  for (const row of tracked || []) {
    const code = String(row.group_id || row.user_id);
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(row);
  }
  const people = [];
  for (const [code, rows] of groups) {
    if (knownCodes.has(code)) continue;
    const byRole = (role) => rows.find((row) => row.role === role);
    const main = byRole("본") || rows.find((row) => String(row.user_id) === code) || rows[0];
    const sub1 = byRole("서브1");
    const sub2 = byRole("서브2");
    const id = (row) => (row ? { user_id: String(row.user_id) } : undefined);
    people.push({
      code,
      name: main.user_name || rows.find((row) => row.user_name)?.user_name || code,
      rank: main.rank_name || "",
      main: id(main),
      s1: id(sub1) || (sub2 ? undefined : id(main)),
      s2: id(sub2),
      tracked: true,
    });
  }
  return people;
}
