const networkLetter = (network) => {
  const value = String(network || "").trim().toLowerCase();
  if (/lg|u\+|엘지|l\s*망|^l$/.test(value)) return "L";
  if (/kt|케이티|k\s*망|^k$/.test(value)) return "K";
  return "";
};

const planToken = (plan) =>
  String(plan || "").replace(/요금제/g, "").replace(/\s+/g, "");

const dateToken = (date) => {
  const match = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1].slice(2)}${match[2]}${match[3]}` : "";
};

// 이름에 이미 날짜가 들어 있는지: 1016·261016 같은 4~6자리 숫자 또는 11.22 같은 월.일
const hasDateLike = (text) =>
  /\d{4,6}/.test(text) ||
  /(^|[^\d.])(0?[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])(?![\d.])/.test(text);

// 고객 이름: "고객명 L396 261127" (통신사 글자+요금제, 가입일 yymmdd).
// 비어 있는 항목은 건너뛴다. 이름에 요금제나 날짜를 이미 적어 둔 경우("이종휘 L396 1016")는
// 그 부분을 다시 붙이지 않아서 여러 번 적용해도 같은 결과가 나온다.
export function contactName(row) {
  const name = String(row?.name || "").trim();
  const plan = planToken(row?.plan);
  const compact = name.replace(/\s+/g, "").toLowerCase();
  const planDone = plan && compact.includes(plan.toLowerCase());
  const letter = plan && !/^[LK]/i.test(plan) ? networkLetter(row?.network) : "";
  const date = hasDateLike(name) ? "" : dateToken(row?.activation_date);
  return [name, plan && !planDone ? `${letter}${plan}` : "", date]
    .filter(Boolean)
    .join(" ");
}
