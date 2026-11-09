// Bantuan penilaian essay: persentase kata kunci yang muncul di jawaban. Hanya saran, nilai tetap dipilih HR.

const normalize = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Kata kunci satu per baris; baris kosong dan duplikat (tanpa beda huruf) dibuang. */
export function parseKeywords(text) {
  const seen = new Set();
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !seen.has(line.toLowerCase()) && seen.add(line.toLowerCase()));
}

/**
 * null kalau soal tanpa kata kunci. suggested: >= 80% = 2, >= 50% = 1, selain itu 0 (dari rasio tanpa pembulatan).
 * shortcut: tanpa toleransi salah ketik atau imbuhan, tambahkan bila HR sering menemukan kecocokan yang terlewat
 */
export function matchKeywords(answerText, keywordsText) {
  const keywords = parseKeywords(keywordsText);
  if (!keywords.length) return null;
  const answer = normalize(answerText);
  const matched = keywords.filter((k) => answer.includes(normalize(k)));
  const ratio = matched.length / keywords.length;
  return {
    percent: Math.round(ratio * 100),
    matched,
    missing: keywords.filter((k) => !matched.includes(k)),
    suggested: ratio >= 0.8 ? 2 : ratio >= 0.5 ? 1 : 0,
  };
}
