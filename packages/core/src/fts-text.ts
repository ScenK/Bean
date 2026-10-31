// Shared FTS5 text prep for memory recall and note search. SQLite's default `unicode61`
// tokenizer makes a whole unspaced CJK run one token, so "牙医" never matches inside
// "我的牙医是张医生". Both sides (indexed text and query) go through cjkBigrams(), which turns
// each CJK run into overlapping two-character tokens; everything else passes through unchanged.
// Deterministic on purpose: no Intl.Segmenter, no dependence on the bundled ICU version.

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/** Rewrites each Han/Hiragana/Katakana/Hangul run as space-separated overlapping bigrams,
 * padded with spaces so adjacent text separates (`dentist牙医` → `dentist 牙医 `). A
 * one-character run stays as it is. Known limit: a one-character query can't match the last
 * character of a run (`所` won't find `牙医诊所`). */
export function cjkBigrams(text: string): string {
  return text.replace(CJK_RUN, (run) => {
    const chars = [...run];
    if (chars.length === 1) return ` ${run} `;
    const grams: string[] = [];
    for (let i = 0; i < chars.length - 1; i++) grams.push(chars[i]! + chars[i + 1]!);
    return ` ${grams.join(" ")} `;
  });
}

const MAX_QUERY_CHARS = 4000;
const MAX_TERMS = 64;

/** FTS5 MATCH expression for free text: an OR of individually quoted prefix terms (`"t"*`,
 * quotes doubled, so text can't inject FTS5 syntax — still pass it as a bound parameter).
 * Keeps the newest terms: the input is bounded from its end and capped at MAX_TERMS from the
 * end, since chime-in text is oldest-first. Returns "" when there's nothing to search for. */
export function ftsMatchQuery(text: string): string {
  const words = cjkBigrams(text.slice(-MAX_QUERY_CHARS)).toLowerCase().split(/\s+/).filter(Boolean);
  const newest = [...new Set(words.reverse())].slice(0, MAX_TERMS);
  return newest.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" OR ");
}
