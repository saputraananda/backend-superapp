export const KPI_TARGET_HOURS = 208;

const roundToTwoDecimals = (value) => Number(Number(value).toFixed(2));
const percentOfTarget = (hours) => roundToTwoDecimals((hours / KPI_TARGET_HOURS) * 100);

/** Status evaluasi berdasarkan total capaian (%) terhadap target jam. */
export function kpiStatusLabel(totalPercent) {
  if (totalPercent >= 100) return "Melampaui Target";
  if (totalPercent >= 90) return "Sangat Baik";
  if (totalPercent >= 60) return "Produktif";
  return "Cukup";
}

const withPercentages = (hoursByComponent) => {
  const totalHours = roundToTwoDecimals(
    hoursByComponent.waschen_hours + hoursByComponent.home_service_hours + hoursByComponent.take_home_hours
  );
  const totalPercent = percentOfTarget(totalHours);
  return {
    waschen_hours: roundToTwoDecimals(hoursByComponent.waschen_hours),
    waschen_pct: percentOfTarget(hoursByComponent.waschen_hours),
    home_service_hours: roundToTwoDecimals(hoursByComponent.home_service_hours),
    home_service_pct: percentOfTarget(hoursByComponent.home_service_hours),
    take_home_hours: roundToTwoDecimals(hoursByComponent.take_home_hours),
    take_home_pct: percentOfTarget(hoursByComponent.take_home_hours),
    total_hours: totalHours,
    target_hours: KPI_TARGET_HOURS,
    total_pct: totalPercent,
    status: kpiStatusLabel(totalPercent),
  };
};

/**
 * Gabungkan KPI tiga komponen (By Waschen, Home Service, Take Home) per nama worker.
 * Input: array `summary` tiap komponen, minimal berisi `name` dan `total_hours`.
 * Worker yang tidak muncul di suatu komponen dihitung 0 jam di komponen itu.
 */
export function combineWorkerKpi({ waschen = [], homeService = [], takeHome = [] }) {
  const hoursByName = new Map();
  const sourceRowsByComponent = {
    waschen_hours: waschen,
    home_service_hours: homeService,
    take_home_hours: takeHome,
  };

  for (const [componentKey, rows] of Object.entries(sourceRowsByComponent)) {
    for (const row of rows) {
      const name = String(row?.name || "").trim();
      if (!name) continue;
      if (!hoursByName.has(name)) {
        hoursByName.set(name, { waschen_hours: 0, home_service_hours: 0, take_home_hours: 0 });
      }
      hoursByName.get(name)[componentKey] += Number(row.total_hours) || 0;
    }
  }

  const workers = Array.from(hoursByName.entries())
    .map(([name, hoursByComponent]) => ({ name, ...withPercentages(hoursByComponent) }))
    .sort((a, b) => b.total_hours - a.total_hours || a.name.localeCompare(b.name));
  workers.forEach((worker, index) => {
    worker.rank = index + 1;
  });

  const workerCount = workers.length;
  const sumHours = (key) => workers.reduce((sum, worker) => sum + worker[key], 0);
  const averageHours = (key) => (workerCount > 0 ? sumHours(key) / workerCount : 0);
  const average = {
    worker_count: workerCount,
    ...withPercentages({
      waschen_hours: averageHours("waschen_hours"),
      home_service_hours: averageHours("home_service_hours"),
      take_home_hours: averageHours("take_home_hours"),
    }),
  };

  return { workers, average };
}
