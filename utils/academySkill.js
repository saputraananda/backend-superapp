/** Mengembalikan pesan error, atau null kalau valid. */
export function validateSkillStructure(categories) {
  if (!categories.length) return null;

  for (const category of categories) {
    if (!String(category.name ?? "").trim()) return "Nama kategori wajib diisi";
    if (!(Number(category.weight) > 0)) return `Bobot ${category.name} harus lebih dari 0`;

    const indicators = category.indicators ?? [];
    if (!indicators.length) return `Kategori ${category.name} wajib punya indikator`;
    if (indicators.some((i) => !String(i.name ?? "").trim())) return `Nama indikator di ${category.name} wajib diisi`;
  }

  // Dibulatkan supaya 33,3 + 33,3 + 33,4 tidak gagal karena presisi float.
  const total = categories.reduce((sum, c) => sum + Number(c.weight), 0);
  if (Math.round(total * 100) !== 10000) return "Total bobot kategori harus 100%";
  return null;
}
