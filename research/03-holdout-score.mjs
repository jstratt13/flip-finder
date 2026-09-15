// Score the judge on 60 results it was never tuned on. Labels were written by
// Claude from the titles before running the judge on this set.
import { readFileSync } from 'node:fs';
import { identity, judgeResult } from './lib/identity.mjs';

const T = true, F = false, U = null;
// index → is this result the listing's product? (U = can't tell from the title)
const truth = [
  F, T, F, F, T, F, U, F, F, T, // 0-9   (4: "Martenz" typo, real product)
  T, F, F, F, F, T, F, F, F, F, // 10-19
  F, F, F, F, T, T, F, F, F, F, // 20-29 (25: typo)
  T, F, T, F, F, F, F, T, F, T, // 30-39
  T, U, T, T, T, T, T, T, T, F, // 40-49
  F, U, F, F, T, T, F, T, F, F, // 50-59 (57: typo)
];
const TYPO = new Set([4, 25, 57]);

const set = JSON.parse(readFileSync(new URL('./out/03-holdout.json', import.meta.url), 'utf8'));
let tk = 0, fk = 0, td = 0, fd = 0, unclear = 0, typo = 0;
const errors = [];
set.forEach((s, i) => {
  const t = truth[i];
  const j = judgeResult(s.result, identity(s.listing));
  if (t === null) { unclear++; return; }
  if (TYPO.has(i)) { typo++; return; } // misspelled brand in the listing: out of the judge's scope
  const kept = j.relevant === true;
  if (kept && t) tk++;
  else if (kept && !t) { fk++; errors.push(`kept wrongly    #${i}: ${s.result}`); }
  else if (!kept && !t) td++;
  else { fd++; errors.push(`dropped wrongly #${i} (${j.why}): ${s.result}`); }
});
const n = tk + fk + td + fd;
console.log(`holdout: ${n} scored (+${unclear} unclear, ${typo} brand-typo excluded) | accuracy ${Math.round(((tk + td) / n) * 100)}%`);
console.log(`keep precision ${Math.round((tk / (tk + fk)) * 100)}% (${tk}/${tk + fk}) | recall ${Math.round((tk / (tk + fd)) * 100)}% (${tk}/${tk + fd})`);
for (const e of errors) console.log('  ' + e.slice(0, 130));
