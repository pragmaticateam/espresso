const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const dir = process.argv[2];

// key -> { src, Map(`${start}:${end}` -> maxCount) }
const files = new Map();

for (const entry of fs.readdirSync(dir)) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
  for (const script of data.result) {
    if (!script.url.includes('/dist/') || !script.url.endsWith('.js')) continue;
    const key = script.url.split('/dist/')[1];
    if (!files.has(key)) {
      let src = script.source;
      if (!src) src = fs.readFileSync(fileURLToPath(script.url), 'utf8');
      files.set(key, { src, ranges: new Map() });
    }
    const rec = files.get(key);
    const visit = (fn) => {
      for (const r of fn.ranges) {
        const k = `${r.startOffset}:${r.endOffset}`;
        rec.ranges.set(k, Math.max(rec.ranges.get(k) ?? 0, r.count));
      }
    };
    script.functions.forEach(visit);
  }
}

for (const [key, { src, ranges }] of files) {
  const lineStarts = [];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0, hi = lineStarts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lineStarts[mid] <= offset) lo = mid + 1; else hi = mid; }
    return lo + 1;
  };
  const deadLines = new Set();
  const details = [];
  for (const [k, count] of ranges) {
    if (count !== 0) continue;
    const [s, e] = k.split(':').map(Number);
    if (e <= s) continue;
    const from = lineOf(s);
    const to = lineOf(e - 1);
    details.push(`   ${from === to ? `L${from}` : `L${from}-L${to}`}: ${JSON.stringify(src.slice(s, Math.min(e, s + 60)))}`);
    for (let l = from; l <= to; l++) deadLines.add(l);
  }
  if (deadLines.size) {
    console.log(`\n== ${key} (lines ${[...deadLines].sort((a, b) => a - b).join(', ')})`);
    console.log(details.sort().join('\n'));
  }
}
