import mysql from "mysql2";
import { safeMyWaschenQuery } from "../../../db/pool.js";

/**
 * Target Waschen — sumber: DB My Waschen.
 *   - Target sales per outlet per bulan : mst_target_waschen (outlet_id, tahun, bulan, nominal)
 *   - Target customer per tahun         : mst_target_customer_waschen (tahun, jumlah)
 * (dulu waschen_smartlink.target_sales / target_customer — tidak dipakai lagi)
 *
 * ATURAN OTOMATIS: periode yang belum diisi target mengikuti target periode sebelumnya
 * (bulan sebelumnya untuk sales, tahun sebelumnya untuk customer). Nilai otomatis TIDAK
 * disimpan ke DB — dihitung saat dibaca dan ditandai is_auto = true. Begitu admin mengisi
 * target periode itu, nilai tersimpan menggantikan nilai otomatis.
 *
 * Perhitungan Sales (appController.getSalesStats, salesDashboard/salesController) berjalan di DB
 * Smartlink dan mencocokkan target ke penjualan lewat NAMA outlet Smartlink, jadi outlet_id
 * dipetakan ke nama tersebut. Outlet tanpa padanan Smartlink (Event Haji, Drop Point) belum
 * punya penjualan di Smartlink sehingga tidak ikut perhitungan Sales.
 */

/** outlet_id My Waschen → nama outlet di Smartlink (sama dengan waschen-mobile leader.js) */
export const SMARTLINK_OUTLET_BY_ID = {
  1: "Waschen Laundry Raffles Hills",
  2: "Waschen Citra Grand",
  3: "Waschen Laundry Legenda Wisata",
  4: "Waschen Laundry Canadian",
  5: "Waschen Laundry Kota Wisata", // Sentra Eropa = Kota Wisata
};

/* ── periode (YYYYMM) ─────────────────────────────────────────── */
export const toYm = (tahun, bulan) => Number(tahun) * 100 + Number(bulan);
export const ymYear = (ym) => Math.floor(ym / 100);
export const ymMonth = (ym) => ym % 100;
export function addMonths(ym, n) {
  const idx = ymYear(ym) * 12 + (ymMonth(ym) - 1) + n;
  return Math.floor(idx / 12) * 100 + (idx % 12) + 1;
}

/** Bulan tagihan berjalan (tanggal 26 ke atas sudah masuk bulan berikutnya), zona WIB. */
export function currentBillingYm(now = new Date()) {
  const wib = new Date(now.getTime() + (7 * 60 + now.getTimezoneOffset()) * 60000);
  const ym = toYm(wib.getFullYear(), wib.getMonth() + 1);
  return wib.getDate() >= 26 ? addMonths(ym, 1) : ym;
}

/** Batas pengisian otomatis: sampai bulan tagihan berikutnya (bulan depan ikut terisi). */
export const autoFillHorizonYm = () => addMonths(currentBillingYm(), 1);

/* ── target sales ─────────────────────────────────────────────── */

/** Semua target tersimpan (opsional satu outlet). */
export async function loadExplicitSalesTargets({ outletId = null } = {}) {
  const [rows] = await safeMyWaschenQuery(
    `SELECT id, outlet_id, tahun, bulan, nominal, created_at, updated_at
     FROM mst_target_waschen
     ${outletId ? "WHERE outlet_id = ?" : ""}
     ORDER BY outlet_id, tahun, bulan`,
    outletId ? [Number(outletId)] : []
  );
  return rows.map((r) => ({ ...r, outlet_id: Number(r.outlet_id), tahun: Number(r.tahun), bulan: Number(r.bulan), nominal: Number(r.nominal) || 0 }));
}

/**
 * Lengkapi target per outlet: bulan kosong di antara / sesudah target tersimpan diisi
 * target bulan sebelumnya (is_auto). Rentang per outlet: bulan target pertama s/d
 * max(target terakhir, untilYm).
 */
export function fillSalesTargets(explicitRows, untilYm = autoFillHorizonYm()) {
  const byOutlet = new Map();
  for (const r of explicitRows) {
    if (!byOutlet.has(r.outlet_id)) byOutlet.set(r.outlet_id, new Map());
    byOutlet.get(r.outlet_id).set(toYm(r.tahun, r.bulan), r);
  }
  const out = [];
  for (const [outletId, months] of byOutlet) {
    const yms = [...months.keys()].sort((a, b) => a - b);
    const end = Math.max(yms[yms.length - 1], untilYm);
    let last = null;
    for (let ym = yms[0]; ym <= end; ym = addMonths(ym, 1)) {
      const row = months.get(ym);
      if (row) {
        last = row;
        out.push({ ...row, is_auto: false, source_tahun: row.tahun, source_bulan: row.bulan });
      } else if (last) {
        out.push({
          id: null,
          outlet_id: outletId,
          tahun: ymYear(ym),
          bulan: ymMonth(ym),
          nominal: last.nominal,
          is_auto: true,
          source_tahun: last.tahun,
          source_bulan: last.bulan,
          created_at: null,
          updated_at: null,
        });
      }
    }
  }
  return out;
}

/** Target efektif (tersimpan + otomatis) untuk satu bulan, semua outlet. */
export async function getEffectiveSalesTargetsForMonth(tahun, bulan) {
  const want = toYm(tahun, bulan);
  const filled = fillSalesTargets(await loadExplicitSalesTargets(), Math.max(want, autoFillHorizonYm()));
  return filled.filter((r) => toYm(r.tahun, r.bulan) === want);
}

/** Baris target untuk perhitungan Sales (nama outlet Smartlink), sudah termasuk otomatis. */
export async function loadTargetSalesRows() {
  return fillSalesTargets(await loadExplicitSalesTargets())
    .map((r) => ({ outlet: SMARTLINK_OUTLET_BY_ID[r.outlet_id] || null, tahun: r.tahun, bulan: r.bulan, nominal: r.nominal }))
    .filter((r) => r.outlet);
}

/**
 * Tabel turunan pengganti `target_sales` untuk dipakai di query DB Smartlink:
 * kolom (outlet, tahun, bulan, nominal). Nilai DITANAM di SQL lewat mysql.format (escape resmi
 * mysql2), bukan placeholder — query Sales lama mengirim parameter filter outlet dobel
 * (buildOutletFilter), jadi menyisipkan placeholder baru akan menggeser urutan parameter.
 */
export function targetSalesDerivedSql(rows) {
  if (!rows?.length) {
    return "(SELECT CAST(NULL AS CHAR(150)) AS outlet, 0 AS tahun, 0 AS bulan, 0 AS nominal FROM DUAL WHERE 1 = 0)";
  }
  const one = "SELECT CAST(? AS CHAR(150)) AS outlet, CAST(? AS UNSIGNED) AS tahun, CAST(? AS UNSIGNED) AS bulan, CAST(? AS SIGNED) AS nominal";
  return `(${rows.map((r) => mysql.format(one, [r.outlet, r.tahun, r.bulan, r.nominal])).join(" UNION ALL ")})`;
}

/* ── target customer ──────────────────────────────────────────── */

export async function loadCustomerTargets() {
  const [rows] = await safeMyWaschenQuery(
    "SELECT id, tahun, jumlah, created_at, updated_at FROM mst_target_customer_waschen ORDER BY tahun DESC"
  );
  return rows.map((r) => ({ ...r, tahun: Number(r.tahun), jumlah: Number(r.jumlah) || 0 }));
}

/** Target customer satu tahun; tahun kosong mengikuti tahun sebelumnya terdekat (is_auto). */
export function effectiveCustomerTarget(rows, tahun) {
  const exact = rows.find((r) => r.tahun === Number(tahun));
  if (exact) return { ...exact, is_auto: false, source_tahun: exact.tahun };
  const prev = rows.filter((r) => r.tahun < Number(tahun)).sort((a, b) => b.tahun - a.tahun)[0];
  if (!prev) return null;
  return { id: null, tahun: Number(tahun), jumlah: prev.jumlah, is_auto: true, source_tahun: prev.tahun, created_at: null, updated_at: null };
}
