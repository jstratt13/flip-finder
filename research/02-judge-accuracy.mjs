// Re-score the relevance judge against Claude's hand labels on the fixed
// 100-result sample (out/02-judge-spotcheck.json + out/02-judge-labels.json).
import { readFileSync } from 'node:fs';
import { identity, judgeResult } from './lib/identity.mjs';

const sample = JSON.parse(readFileSync(new URL('./out/02-judge-spotcheck.json', import.meta.url), 'utf8'));
const { truth } = JSON.parse(readFileSync(new URL('./out/02-judge-labels.json', import.meta.url), 'utf8'));

let tk = 0, fk = 0, td = 0, fd = 0, unclear = 0;
const errors = [];
sample.forEach((s, i) => {
  const t = truth[i];
  const j = judgeResult(s.result, identity(s.listing));
  if (t === null) { unclear++; return; }
  if (j.relevant === true && t) tk++;
  else if (j.relevant === true && !t) { fk++; errors.push(`kept wrongly    #${i}: ${s.result}`); }
  else if (j.relevant !== true && !t) td++;
  else { fd++; errors.push(`dropped wrongly #${i} (${j.why}): ${s.result}`); }
});
const n = tk + fk + td + fd;
console.log(`labelled ${n} (+${unclear} unclear) | accuracy ${Math.round(((tk + td) / n) * 100)}% | kept: ${tk} right, ${fk} wrong | dropped: ${td} right, ${fd} wrong`);
console.log(`precision of "keep" ${Math.round((tk / (tk + fk)) * 100)}% | recall of true products ${Math.round((tk / (tk + fd)) * 100)}%`);
for (const e of errors) console.log('  ' + e.slice(0, 130));
