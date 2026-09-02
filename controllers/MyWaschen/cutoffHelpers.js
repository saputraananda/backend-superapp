/** Standar cutoff perusahaan: periode bulan X = 26 (X-1) s/d 25 X */

function toDateInput(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function currentCutoffPeriod(now = new Date()) {
  const day = now.getDate();
  if (day >= 26) {
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { year: next.getFullYear(), month: next.getMonth() + 1 };
  }
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export function cutoffRange(year, month) {
  if (!year || !month) return { dateFrom: "", dateTo: "" };
  const y = Number(year);
  const m = Number(month);
  const fromDate = new Date(y, m - 2, 26);
  const toDate = new Date(y, m - 1, 25);
  return { dateFrom: toDateInput(fromDate), dateTo: toDateInput(toDate) };
}

export function defaultCutoffDateRange(now = new Date()) {
  const { year, month } = currentCutoffPeriod(now);
  return cutoffRange(year, month);
}
