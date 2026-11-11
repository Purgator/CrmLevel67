// Tiny fuzzy matcher: every query character must appear in order.
// Higher score = better. Returns -1 when there is no match.

const BOUNDARY = /[\s\-_/.(]/;

export function fuzzyScore(query, text) {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const at = t.indexOf(q);
  if (at !== -1) {
    // Plain substring: best kind of match, better still at a word start.
    const wordStart = at === 0 || BOUNDARY.test(t[at - 1]);
    return 1000 + (wordStart ? 200 : 0) - at - (t.length - q.length) * 0.1;
  }
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    if (ch === ' ') { streak = 0; continue; }
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    const wordStart = found === 0 || BOUNDARY.test(t[found - 1]);
    streak = found === ti ? streak + 1 : 0;
    score += 10 + (wordStart ? 15 : 0) + streak * 5 - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return score;
}

// Rank items by their best score over weighted fields: [[text, weight], ...].
export function fuzzyRank(query, items, fieldsOf) {
  if (!query.trim()) return items.slice();
  const scored = [];
  for (const item of items) {
    let best = -1;
    for (const [text, weight] of fieldsOf(item)) {
      if (!text) continue;
      const s = fuzzyScore(query, text);
      if (s >= 0 && s * weight > best) best = s * weight;
    }
    if (best >= 0) scored.push([best, item]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.map((s) => s[1]);
}
