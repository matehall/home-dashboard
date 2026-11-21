#!/usr/bin/env node
// Sotanalys: när är det dags att sota pannan? Läser röktemperaturen (och utetemperaturen) ur openHAB:s rrd4j-filer, hittar sotningar som fall i
// dygnstoppen, räknar baslinje och stighastighet per intervall och föreslår en gräns ur dina egna tidigare sotningar. Bara läsande.
//
//   node scripts/soot-analysis.js --ssh openhabian@192.168.1.8 [--url http://192.168.1.8:3000]
//   node scripts/soot-analysis.js --rrd-dir ./rrd --sweep 2026-10-25 --sweep 2026-04-22
//
// Flaggor: --ssh user@host (hämtar filerna med ssh cat), --rrd-dir mapp, --rrd-path (standard /var/lib/openhab/persistence/rrd4j),
//   --url dashboardens bas-URL (kalibrering mot rådata), --sweep YYYY-MM-DD (bekräftade sotningar, kan upprepas; ersätter de funna),
//   --drop K (minsta fall, standard 6), --base-days N (standard 7), --json.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseRrd, archiveSeries, archiveByResolution } = require('./lib/rrd4j');
const S = require('./lib/soot');

const SMOKE = 'Weatherstation_Rok_temp.rrd';
const OUTDOOR = 'Weatherstation_Utetemperatur.rrd';

function parseArgs(argv) {
  const args = { sweep: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    const val = !next || next.startsWith('--') ? true : next;
    if (val !== true) i += 1;
    if (key === 'sweep') args.sweep.push(val); else args[key] = val;
  }
  return args;
}

function readRrd(args, name) {
  if (args['rrd-dir']) return parseRrd(fs.readFileSync(path.join(args['rrd-dir'], name)));
  if (args.ssh) {
    const remote = `${args['rrd-path'] ?? '/var/lib/openhab/persistence/rrd4j'}/${name}`;
    return parseRrd(execFileSync('ssh', ['-o', 'BatchMode=yes', args.ssh, 'cat', remote], { maxBuffer: 64 * 1024 * 1024 }));
  }
  throw new Error('Ange --ssh user@host eller --rrd-dir mapp');
}

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');
const sgn = (x) => (x >= 0 ? '+' : '') + f1(x);

// Dygnsserie i "15-minutersmedel"-enhet: 15-minutersarkivet där det finns (sedan nov 2025), annars timarkivet omräknat med en linjär anpassning
// mot de dygn där båda finns. Utetemperatur (dygnsmedel) kommer ur timarkivet.
function buildDays(smoke, outdoor) {
  const a15 = archiveByResolution(smoke, 900); const aH = archiveByResolution(smoke, 3600); const uH = archiveByResolution(outdoor, 3600);
  const d15 = S.toDaily(archiveSeries(smoke, a15), 90);
  const dH = S.toDaily(archiveSeries(smoke, aH), 22);
  const ute = new Map(S.toDaily(archiveSeries(outdoor, uH), 22).map((d) => [d.day, d.mean]));
  const m15 = new Map(d15.map((d) => [d.day, d.max]));
  const pairs = dH.filter((d) => m15.has(d.day));
  const fit = pairs.length >= 30 ? S.ols(pairs.map((d) => d.max), pairs.map((d) => m15.get(d.day))) : { slope: 1, intercept: 0, r2: 0, n: pairs.length };
  const out = [];
  for (const d of dH) {
    if (!ute.has(d.day)) continue;
    if (m15.has(d.day)) out.push({ day: d.day, max: m15.get(d.day), ute: ute.get(d.day), src: '15' });
    else if (d.day < d15[0].day) out.push({ day: d.day, max: fit.intercept + fit.slope * d.max, ute: ute.get(d.day), src: 'h' });
  }
  for (const d of d15) if (!dH.some((x) => x.day === d.day) && ute.has(d.day)) out.push({ day: d.day, max: d.max, ute: ute.get(d.day), src: '15' });
  return { days: out.sort((a, b) => a.day - b.day), fit, firstDay15: d15[0].day };
}

async function calibrateAgainstRaw(url, days) {
  const res = await fetch(`${url}/api/history?sensor=rok_temp&from=0&resolution=day`);
  const raw = (await res.json()).raw;
  const daily = S.toDaily(S.bucketMeans(raw, 900), 90);
  const mine = new Map(days.filter((d) => d.src === '15').map((d) => [d.day, d.max]));
  const diffs = daily.filter((d) => mine.has(d.day)).map((d) => d.max - mine.get(d.day));
  const rawPeak = new Map(); for (const r of raw) { const d = S.dayIndex(r.ts); rawPeak.set(d, Math.max(rawPeak.get(d) ?? -Infinity, r.value)); }
  const peakDiffs = [...rawPeak].filter(([d]) => mine.has(d)).map(([d, v]) => v - mine.get(d));
  return { n: diffs.length, bucketVsArchive: S.median(diffs), rawPeakVsArchive: S.median(peakDiffs) };
}

function analyse(days, k, { drop, baseDays, sweepDays, fineFromDay }) {
  const corr = S.withCorrection(days, k);
  const found = S.detectSweeps(corr, { drop });
  const sweeps = sweepDays?.length ? sweepDays.map((d) => ({ day: d })) : found;
  const intervals = S.intervalStats(corr, sweeps, { baseDays, fineFromDay });
  return { corr, found, sweeps, intervals, rec: S.recommend(intervals) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const drop = Number(args.drop ?? 6); const baseDays = Number(args['base-days'] ?? 7);
  const smoke = readRrd(args, SMOKE); const outdoor = readRrd(args, OUTDOOR);
  const { days, fit, firstDay15 } = buildDays(smoke, outdoor);
  // Utekorrigeringen skattas bara ur 15-minutersdygnen (timdata sudda ut topparna och ger ett sämre samband).
  const ute = S.estimateUteSlope(days.filter((d) => d.day >= firstDay15));
  const sweepDays = args.sweep.map(S.dayFromLabel);
  const r = analyse(days, ute.slope, { drop, baseDays, sweepDays, fineFromDay: firstDay15 });
  const cal = args.url ? await calibrateAgainstRaw(args.url, days) : null;

  const line = (...p) => console.log(...p);
  line(`Data: ${S.dayLabel(days[0].day)} till ${S.dayLabel(days.at(-1).day)}, ${days.length} dygn (15-minutersmedel sedan ${S.dayLabel(firstDay15)}, före det timmedel omräknat).`);
  line(`Timmedel -> 15-minutersmedel: max15 = ${f1(fit.intercept)} + ${fit.slope.toFixed(3)} * maxTimme (R2 ${fit.r2.toFixed(2)}, ${fit.n} dygn).`);
  line(`Utekorrigering: ${f1(ute.slope)} K rök per grad ute (R2 ${ute.r2.toFixed(2)}, ${ute.n} dygnsskillnader). Allt nedan är korrigerat till 0 °C ute.`);
  if (cal) line(`Kalibrering mot rådata (${cal.n} dygn): rådatats 15-minutersmedel är ${sgn(cal.bucketVsArchive)} K mot arkivet; rådatans högsta enskilda värde är ${sgn(cal.rawPeakVsArchive)} K över arkivets dygnsmax.`);

  line(`\nSotningar (${sweepDays.length ? 'bekräftade, angivna med --sweep' : `kandidater: fall på minst ${drop} K`}):`);
  line('datum        före  efter  fall');
  for (const s of (sweepDays.length ? r.sweeps.map((x) => r.found.find((f) => Math.abs(f.day - x.day) <= 3) ?? x) : r.found)) {
    line(`${S.dayLabel(s.day)}  ${f1(s.before).padStart(5)} ${f1(s.after).padStart(6)} ${f1(s.fall).padStart(5)}`);
  }

  line('\nIntervall mellan sotningar (korrigerade °C):');
  line('från         dygn  baslinje  nivå före  stigning  K/dygn  status');
  for (const i of r.intervals) {
    line(`${S.dayLabel(i.from)}  ${String(i.spanDays).padStart(4)}  ${f1(i.base).padStart(8)}  ${f1(i.level).padStart(9)}  ${sgn(i.rise).padStart(8)}  ${i.slope.toFixed(2).padStart(6)}  ${i.closed ? 'sotad' : 'pågår'}${i.rough ? '  (grov, timdata, räknas inte med)' : ''}`);
  }

  const now = r.intervals.at(-1);
  if (r.rec) {
    line(`\nRekommenderad gräns (${r.rec.n} avslutade intervall, stigning före sotning ${f1(r.rec.min)} till ${f1(r.rec.max)} K, median ${f1(r.rec.sweepAt)} K):`);
    line(`  varning vid ${sgn(r.rec.warnAt)} K över baslinjen, sota vid ${sgn(r.rec.sweepAt)} K, senast vid ${sgn(r.rec.latestAt)} K (övre kvartilen)`);
    if (now && !now.closed) {
      const recent = r.corr.filter((d) => d.day > r.corr.at(-1).day - 14);
      const recentSlope = S.theilSen(recent.map((d) => d.day), recent.map((d) => d.corr));
      const typical = S.median(r.intervals.filter((i) => i.closed && i.slope > 0).map((i) => i.slope));
      const eta = (limit, slope) => { const d = S.daysUntil(now.rise, limit, slope); return d === null ? 'ingen stigning' : `${Math.round(d)} dygn`; };
      line(`  nu: baslinje ${f1(now.base)}, nivå ${f1(now.level)}, stigning ${sgn(now.rise)} K efter ${now.spanDays} dygn`);
      line(`  prognos till varning: ${eta(r.rec.warnAt, recentSlope)} (senaste 14 dygnens lutning ${recentSlope.toFixed(2)} K/dygn), ${eta(r.rec.warnAt, typical)} (typisk lutning ${typical.toFixed(2)} K/dygn)`);
      line(`  prognos till sotning: ${eta(r.rec.sweepAt, recentSlope)} resp. ${eta(r.rec.sweepAt, typical)}; senast: ${eta(r.rec.latestAt, recentSlope)} resp. ${eta(r.rec.latestAt, typical)}`);
    }
  }

  line('\nKänslighet (sotningsgräns som stigning i K, och antal sotningar):');
  for (const dr of [4, 6, 8]) {
    const cells = [5, 7, 10].map((bd) => { const x = analyse(days, ute.slope, { drop: dr, baseDays: bd, sweepDays, fineFromDay: firstDay15 }); return `${x.rec ? f1(x.rec.sweepAt) : '–'} K/${x.sweeps.length} st`; });
    line(`  fall ≥ ${dr} K:  baslinje 5 d ${cells[0]},  7 d ${cells[1]},  10 d ${cells[2]}`);
  }
  const noUte = analyse(days, 0, { drop, baseDays, sweepDays, fineFromDay: firstDay15 });
  line(`  utan utekorrigering: ${noUte.rec ? f1(noUte.rec.sweepAt) : '–'} K/${noUte.sweeps.length} st`);
  if (args.json) console.log(JSON.stringify({ ute, fit, cal, sweeps: r.sweeps, intervals: r.intervals, rec: r.rec }, null, 2));
}

main().catch((err) => { console.error(err.message); process.exit(1); });
