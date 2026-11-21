// Sotanalys av röktemperaturen. Rena funktioner (ingen I/O) så att de går att testa.
// Idé: sot isolerar värmeytorna, så rökgasen blir varmare. Dygnets högsta röktemperatur stiger långsamt och faller tvärt när pannan sotas
// (sågtand). Utetemperaturen påverkar också (kallt ger mer last och varmare rök), så den korrigeras bort först.

const DAY_MS = 86400000;

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Theil-Sen: median av alla parvisa lutningar. Tål enstaka avvikare, till skillnad från minsta kvadrat.
function theilSen(xs, ys) {
  const slopes = [];
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = i + 1; j < xs.length; j += 1) {
      if (xs[j] !== xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
    }
  }
  return median(slopes);
}

function ols(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i += 1) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy ? (sxy * sxy) / (sxx * syy) : 0, n };
}

const dayIndex = (ts) => Math.floor(ts / DAY_MS);
const dayLabel = (idx) => new Date(idx * DAY_MS).toISOString().slice(0, 10);
const dayFromLabel = (label) => dayIndex(Date.parse(`${label}T00:00:00Z`));

// Dygnsmax och dygnsmedel (UTC-dygn). Dygn med för få värden (minCount) kastas, så att halva dygn inte ger fel max.
function toDaily(series, minCount) {
  const by = new Map();
  for (const { ts, value } of series) {
    const d = dayIndex(ts - 1); // radens slut hör till raden, så en rad som slutar 00:00 tillhör dygnet före
    let e = by.get(d);
    if (!e) { e = { day: d, max: -Infinity, sum: 0, n: 0 }; by.set(d, e); }
    if (value > e.max) e.max = value;
    e.sum += value; e.n += 1;
  }
  return [...by.values()].filter((e) => e.n >= minCount).map((e) => ({ day: e.day, max: e.max, mean: e.sum / e.n })).sort((a, b) => a.day - b.day);
}

// Lutning för rök mot utetemperatur ur dygnsskillnader (tar bort den långsamma sotstrykningen). Hoppar över dygn med stora språng (sotning).
function estimateUteSlope(days, maxJump = 5) {
  const xs = []; const ys = [];
  for (let i = 1; i < days.length; i += 1) {
    if (days[i].day - days[i - 1].day !== 1) continue;
    const dy = days[i].max - days[i - 1].max;
    if (Math.abs(dy) > maxJump) continue;
    xs.push(days[i].ute - days[i - 1].ute); ys.push(dy);
  }
  return xs.length >= 10 ? ols(xs, ys) : { slope: 0, intercept: 0, r2: 0, n: xs.length };
}

const withCorrection = (days, k, uteRef = 0) => days.map((d) => ({ ...d, corr: d.max - k * (d.ute - uteRef) }));

// Täta dygnslista (null där dygn saknas) för enklare fönsterberäkningar.
function dense(days) {
  if (!days.length) return { start: 0, arr: [] };
  const start = days[0].day;
  const arr = new Array(days.at(-1).day - start + 1).fill(null);
  for (const d of days) arr[d.day - start] = d;
  return { start, arr };
}

// Sotningskandidater: fall i dygnstoppen. Jämför medianen av 4 dygn före med medianen av 3 dygn från och med dagen, och tar största fallet
// per kluster (minGapDays emellan). Returnerar [{ day, fall, before, after }].
function detectSweeps(days, { drop = 6, minGapDays = 14, minAfter = 85 } = {}) {
  const { start, arr } = dense(days);
  const val = (i) => (arr[i] ? arr[i].corr : NaN);
  const cands = [];
  for (let i = 4; i < arr.length - 2; i += 1) {
    if (!arr[i]) continue;
    const before = median([val(i - 4), val(i - 3), val(i - 2), val(i - 1)]);
    const after = median([val(i), val(i + 1), val(i + 2)]);
    // minAfter: ett fall ner under normal drifttemperatur är ett stillestånd eller mycket låg last, inte en sotning
    if (Number.isFinite(before) && Number.isFinite(after) && before - after >= drop && after >= minAfter) cands.push({ day: start + i, fall: before - after, before, after });
  }
  const picked = [];
  for (const c of cands) {
    const last = picked.at(-1);
    if (last && c.day - last.day < minGapDays) { if (c.fall > last.fall) picked[picked.length - 1] = c; } else picked.push(c);
  }
  return picked;
}

// Intervall mellan sotningar: baslinje (median av första baseDays dygnen, med 1 dygns marginal efter sotningen), stighastighet (Theil-Sen, K/dygn),
// nivå före nästa sotning (median av de 3 sista dygnen) och längd. Det sista, pågående intervallet får closed=false.
function intervalStats(days, sweeps, { baseDays = 7, fineFromDay = -Infinity } = {}) {
  const bounds = [...sweeps.map((s) => s.day), Infinity];
  const out = [];
  for (let b = 0; b < sweeps.length; b += 1) {
    const from = bounds[b]; const to = bounds[b + 1];
    const seg = days.filter((d) => d.day >= from && d.day < to);
    if (seg.length < baseDays + 3) continue;
    const base = median(seg.filter((d) => d.day >= from + 1 && d.day < from + 1 + baseDays).map((d) => d.corr));
    const tail = seg.slice(-3).map((d) => d.corr);
    const level = median(tail);
    out.push({
      rough: from < fineFromDay, from, to: Number.isFinite(to) ? to : seg.at(-1).day + 1, closed: Number.isFinite(to), spanDays: seg.at(-1).day - from + 1,
      base, level, rise: level - base,
      slope: theilSen(seg.map((d) => d.day), seg.map((d) => d.corr)),
    });
  }
  return out;
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q; const lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
}

// Rekommenderad gräns ur de avslutade intervallen (där en sotning faktiskt gjordes): sotning vid medianen av stigningen, "senast" vid övre kvartilen
// och varning vid warnFraction av medianen. Intervall med rough (grova timdata) räknas inte med.
function recommend(intervals, { minSpanDays = 14, warnFraction = 0.7 } = {}) {
  const rises = intervals.filter((i) => i.closed && !i.rough && i.spanDays >= minSpanDays).map((i) => i.rise).sort((a, b) => a - b);
  if (!rises.length) return null;
  const sweepAt = median(rises);
  return { n: rises.length, min: rises[0], max: rises.at(-1), sweepAt, latestAt: quantile(rises, 0.75), warnAt: sweepAt * warnFraction };
}

// Dagar kvar tills stigningen når en gräns, med given lutning (K/dygn). null om lutningen inte är positiv.
const daysUntil = (rise, limit, slope) => (slope > 0 ? Math.max(0, (limit - rise) / slope) : null);

// Medelvärden per tidsbucket (sekunder), som rrd4j-arkiv: bucketen märks med sin slutpunkt. Används för att jämföra rådata med arkivens medel.
function bucketMeans(series, seconds) {
  const ms = seconds * 1000; const by = new Map();
  for (const { ts, value } of series) {
    const end = (Math.floor(ts / ms) + 1) * ms;
    const e = by.get(end) ?? { sum: 0, n: 0 };
    e.sum += value; e.n += 1; by.set(end, e);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([ts, e]) => ({ ts, value: e.sum / e.n }));
}

module.exports = {
  DAY_MS, median, theilSen, ols, dayIndex, dayLabel, dayFromLabel, toDaily, estimateUteSlope, withCorrection,
  detectSweeps, intervalStats, recommend, daysUntil, bucketMeans,
};
