// Sotindikator för köksvyn: hur mycket varmare röken är än när pannan var ren, och hur nära det är dags att sota.
// Sot isolerar värmeytorna, så röktemperaturen (rok_temp) vid varje eldning stiger långsamt tills pannan sotas.
// Mått: toppen av röken per eldning (cykel: över 85 °C till under 75 °C), dygnsmedian av topparna, jämförd med nivån dygnen efter
// senaste sotning. Gränserna (varna +7, sota +10 °C) kommer ur analysen i hubben (investigations/2026-11-21-rok-temp-sotning.md)
// och är provisoriska. Enhet "°C över ren panna" = temperaturskillnad (kelvin).
const fs = require('fs');
const path = require('path');
const { stockholmDate, addDays, stockholmMidnight } = require('./consumption');

const SENSOR = 'rok_temp';
const CFG = {
  start: 85, end: 75, maxValid: 130, minCycleMs: 3 * 60 * 1000, maxGapMs: 30 * 60 * 1000,
  minCyclesPerDay: 3, baseFromDay: 1, baseDays: 6, minBaseDays: 3, recentDays: 3, slopeDays: 14, minSlopeDays: 6,
  warnAt: 7, sweepAt: 10,
};
const DEFAULT_SWEPT_AT = process.env.SOOT_SWEPT_AT || '2026-10-25';
const FILE = path.join(__dirname, 'data', 'soot.json');
const CACHE_MS = 12 * 60 * 60 * 1000; // räknas om högst två gånger per dygn

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Theil-Sen: median av alla parvisa lutningar (tål enstaka avvikare).
function theilSen(xs, ys) {
  const slopes = [];
  for (let i = 0; i < xs.length; i += 1) for (let j = i + 1; j < xs.length; j += 1) if (xs[j] !== xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
  return median(slopes);
}

// readings: [{ ts, value }] i tidsordning. Returnerar toppen per eldning: [{ ts, peak }]. Värden över maxValid (mätspikar) ignoreras,
// en lucka större än maxGapMs avslutar eldningen, och eldningar kortare än minCycleMs kastas.
function cyclePeaks(readings, cfg = CFG) {
  const out = [];
  let cur = null;
  const close = () => { if (cur && cur.lastTs - cur.startTs >= cfg.minCycleMs) out.push({ ts: cur.peakTs, peak: cur.peak }); cur = null; };
  for (const { ts, value } of readings) {
    if (!Number.isFinite(value) || value > cfg.maxValid) continue;
    if (cur && ts - cur.lastTs > cfg.maxGapMs) close();
    if (!cur) { if (value > cfg.start) cur = { startTs: ts, lastTs: ts, peak: value, peakTs: ts }; continue; }
    cur.lastTs = ts;
    if (value > cur.peak) { cur.peak = value; cur.peakTs = ts; }
    if (value < cfg.end) close();
  }
  return out;
}

// Dygnsmedian av eldningstopparna per Stockholm-datum. Dygn med färre än minCyclesPerDay eldningar kastas. Returnerar [{ day, value, n }].
function dailyPeaks(cycles, cfg = CFG) {
  const by = new Map();
  for (const c of cycles) {
    const d = stockholmDate(c.ts);
    if (!by.has(d)) by.set(d, []);
    by.get(d).push(c.peak);
  }
  return [...by.entries()].filter(([, v]) => v.length >= cfg.minCyclesPerDay).map(([day, v]) => ({ day, value: median(v), n: v.length })).sort((a, b) => (a.day < b.day ? -1 : 1));
}

const dayNum = (day) => Date.parse(`${day}T12:00:00Z`) / 86400000;

// Räknar fram läget. readings: rådata för rok_temp från sotdatumet och framåt. sweptAt: "YYYY-MM-DD". now: epoch-ms.
function buildSoot(readings, sweptAt, now, cfg = CFG) {
  const today = stockholmDate(now);
  const base = { sweptAt, warnAt: cfg.warnAt, sweepAt: cfg.sweepAt, computedAt: now, status: 'unknown', rise: null, baseline: null, level: null, slopePerDay: null, daysLeft: null };
  const days = dailyPeaks(cyclePeaks(readings, cfg), cfg).filter((d) => d.day > sweptAt && d.day < today); // dagens dygn är ofullständigt
  const bFrom = addDays(sweptAt, cfg.baseFromDay);
  const bTo = addDays(sweptAt, cfg.baseFromDay + cfg.baseDays - 1);
  const baseDays = days.filter((d) => d.day >= bFrom && d.day <= bTo);
  if (baseDays.length < cfg.minBaseDays) return { ...base, reason: 'baslinje saknas' };
  const baseline = median(baseDays.map((d) => d.value));
  const after = days.filter((d) => d.day > bTo);
  const recent = (after.length >= cfg.recentDays ? after : days).slice(-cfg.recentDays);
  if (!recent.length || (after.length === 0)) return { ...base, baseline, reason: 'för tidigt efter sotning' };
  const level = median(recent.map((d) => d.value));
  const rise = level - baseline;
  const sl = days.slice(-cfg.slopeDays);
  const slopePerDay = sl.length >= cfg.minSlopeDays ? theilSen(sl.map((d) => dayNum(d.day)), sl.map((d) => d.value)) : null;
  const daysLeft = slopePerDay !== null && slopePerDay > 0.02 ? Math.max(0, (cfg.sweepAt - rise) / slopePerDay) : null;
  const status = rise >= cfg.sweepAt ? 'sweep' : rise >= cfg.warnAt ? 'warn' : 'ok';
  return { ...base, status, rise, baseline, level, slopePerDay, daysLeft };
}

function readSweptAt() {
  try {
    const v = JSON.parse(fs.readFileSync(FILE, 'utf8')).sweptAt;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  } catch { /* ingen fil än */ }
  return DEFAULT_SWEPT_AT;
}

// Sparar sotdatumet (t.ex. efter nästa sotning). Datumet måste vara ett riktigt datum, inte i framtiden och efter 2024.
function setSweptAt(date, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) throw new Error('datum ska vara YYYY-MM-DD');
  if (date > stockholmDate(now)) throw new Error('datumet ligger i framtiden');
  if (date < '2024-01-01') throw new Error('datumet är för gammalt');
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ sweptAt: date }));
  cache = null;
  return date;
}

let cache = null;
async function getSoot(now = Date.now()) {
  const sweptAt = readSweptAt();
  if (cache && cache.sweptAt === sweptAt && now - cache.at < CACHE_MS) return cache.value;
  const db = require('./db'); // laddas här så att de rena funktionerna kan testas utan SQLite
  const rows = await db.getRawSeries(SENSOR, stockholmMidnight(sweptAt), now + 1);
  const value = buildSoot(rows, sweptAt, now);
  cache = { at: now, sweptAt, value };
  return value;
}

module.exports = { getSoot, setSweptAt, buildSoot, cyclePeaks, dailyPeaks, median, theilSen, CFG };
