const count = (value) => value != null && value !== "" && typeof value !== "boolean"
  && Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

export function memberLineMetrics(member = {}, consumer = null) {
  const read = (field) => {
    if (!member.lineMetricsFound) return null;
    const value = count(member[field]);
    if (member.lineMetricsVersion >= 2)
      return member.lineMetricsAvailable?.[field] === true ? value : null;
    // Old collectors manufactured 0 for unrecognised keys. A legacy zero is not evidence of no lines.
    return field === "consumerTotalLines" || value > 0 ? value : null;
  };
  const total = read("consumerTotalLines") ?? count(consumer?.["총회선"]);
  return {
    total, real: read("realLines"), own: read("ownSalesLines"), delivery: read("regularDeliveryLines"),
    kt: count(consumer?.["KT망"]), lg: count(consumer?.["LG망"]),
    needsCollectorUpdate: Boolean(member.lineMetricsFound && !(member.lineMetricsVersion >= 2)),
  };
}
