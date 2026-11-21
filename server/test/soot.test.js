const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRrd, archiveSeries, archiveByResolution } = require('../../scripts/lib/rrd4j');
const S = require('../../scripts/lib/soot');

// Bygger en liten rrd4j-fil (samma layout som openHAB:s) med ett arkiv: rows värden och ptr som nästa skrivposition.
function buildRrd({ step = 10, lastUpdate, steps, rows, ptr, values }) {
  const parts = [];
  const str = (s) => { const b = Buffer.alloc(40); for (let i = 0; i < 20; i += 1) b.writeUInt16BE((s[i] ?? ' ').charCodeAt(0), i * 2); parts.push(b); };
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); parts.push(b); };
  const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); parts.push(b); };
  const f64 = (v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); parts.push(b); };
  str('RRD4J, version 0.2'); i64(step); i32(1); i32(1); i64(lastUpdate);
  str('state'); str('GAUGE'); i64(600); f64(NaN); f64(NaN); f64(0); f64(0); i64(0);
  str('AVERAGE'); f64(0.5); i32(steps); i32(rows);
  i32(ptr); f64(NaN); i64(0);
  for (let r = 0; r < rows; r += 1) f64(values[r] ?? NaN);
  return Buffer.concat(parts);
}

test('rrd4j: läser ringbufferten i tidsordning och mappar tider', () => {
  // 4 rader à 900 s, ptr=2: äldsta raden är index 2, nyaste index 1. lastUpdate 1000 s efter en rad-gräns.
  const lastUpdate = 900 * 1000 + 100;
  const rrd = parseRrd(buildRrd({ lastUpdate, steps: 90, rows: 4, ptr: 2, values: [30, 40, 10, 20] }));
  const arc = archiveByResolution(rrd, 900);
  assert.ok(arc);
  const s = archiveSeries(rrd, arc);
  assert.deepEqual(s.map((x) => x.value), [10, 20, 30, 40]);
  assert.equal(s.at(-1).ts, 900 * 1000 * 1000); // nyaste radens slut
  assert.equal(s[1].ts - s[0].ts, 900 * 1000);
});

test('rrd4j: hoppar över tomma (NaN) rader och avvisar andra filer', () => {
  const rrd = parseRrd(buildRrd({ lastUpdate: 3600, steps: 90, rows: 4, ptr: 0, values: [NaN, 5, NaN, 7] }));
  assert.deepEqual(archiveSeries(rrd, rrd.archives[0]).map((x) => x.value), [5, 7]);
  assert.throws(() => parseRrd(Buffer.alloc(300)), /Inte en rrd4j-fil/);
});

test('median, Theil-Sen och OLS', () => {
  assert.equal(S.median([3, 1, 2]), 2);
  assert.equal(S.median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(S.median([])));
  // en avvikare påverkar inte Theil-Sen
  assert.equal(S.theilSen([0, 1, 2, 3, 4], [0, 1, 2, 3, 40]), 1);
  const o = S.ols([0, 1, 2, 3], [1, 3, 5, 7]);
  assert.ok(Math.abs(o.slope - 2) < 1e-9 && Math.abs(o.intercept - 1) < 1e-9 && Math.abs(o.r2 - 1) < 1e-9);
});

test('toDaily: dygnsmax och medel, kastar dygn med för få värden, radens slut hör till raden', () => {
  const day = 86400000;
  const series = [
    { ts: 1 * day, value: 10 }, // slutar 00:00 dag 1: tillhör dag 0
    { ts: 1 * day + 900000, value: 30 }, { ts: 1 * day + 1800000, value: 20 }, // dag 1
    { ts: 2 * day, value: 5 }, // dag 1
  ];
  const d = S.toDaily(series, 2);
  assert.deepEqual(d.map((x) => x.day), [1]);
  assert.equal(d[0].max, 30);
  assert.ok(Math.abs(d[0].mean - (30 + 20 + 5) / 3) < 1e-9);
});

// Sågtand: dygnsmax stiger perDay K/dygn från base och sotas (återställs) vid de givna dygnen. Utetemperaturen ger -k per grad.
function sawtooth({ n, base = 100, perDay = 0.4, sweepAt = [], k = -0.3, uteOf = (i) => Math.sin(i / 5) * 8 }) {
  const days = []; let since = 0;
  for (let i = 0; i < n; i += 1) {
    if (sweepAt.includes(i)) since = 0;
    const ute = uteOf(i);
    days.push({ day: 1000 + i, max: base + perDay * since + k * ute, ute });
    since += 1;
  }
  return days;
}

test('estimateUteSlope hittar utekopplingen trots sågtanden', () => {
  const days = sawtooth({ n: 200, sweepAt: [50, 110, 160] });
  const e = S.estimateUteSlope(days);
  assert.ok(Math.abs(e.slope - -0.3) < 0.1, `slope ${e.slope}`);
  assert.ok(e.n > 150);
});

test('detectSweeps hittar sotningarna, men inte brus, stillestånd eller dubbletter', () => {
  const days = S.withCorrection(sawtooth({ n: 200, sweepAt: [60, 130] }), -0.3);
  const found = S.detectSweeps(days, { drop: 6 });
  assert.equal(found.length, 2);
  assert.ok(found.every((f, i) => Math.abs(f.day - 1000 - [60, 130][i]) <= 2));
  // stillestånd: fall ner till 70 °C är inte en sotning
  const stop = days.map((d) => (d.day >= 1090 && d.day < 1100 ? { ...d, corr: 70 } : d));
  assert.equal(S.detectSweeps(stop, { drop: 6 }).filter((f) => f.day >= 1085 && f.day < 1105).length, 0);
  // inga sotningar: inga kandidater
  assert.equal(S.detectSweeps(S.withCorrection(sawtooth({ n: 100, sweepAt: [] }), -0.3)).length, 0);
});

test('intervalStats: baslinje, stighastighet och nivå per intervall', () => {
  const days = S.withCorrection(sawtooth({ n: 200, sweepAt: [60, 130], uteOf: () => 0 }), 0);
  const sweeps = [{ day: 1060 }, { day: 1130 }];
  const iv = S.intervalStats(days, sweeps, { baseDays: 7 });
  assert.equal(iv.length, 2);
  assert.equal(iv[0].closed, true);
  assert.equal(iv[1].closed, false);
  assert.ok(Math.abs(iv[0].slope - 0.4) < 1e-6);
  assert.ok(Math.abs(iv[0].base - (100 + 0.4 * 4)) < 0.1); // median av dygn 1..7 efter sotningen
  assert.ok(Math.abs(iv[0].rise - (iv[0].level - iv[0].base)) < 1e-9);
  assert.ok(iv[0].rise > 20 && iv[0].rise < 30);
});

test('recommend: median, övre kvartil och varning; grova och öppna intervall räknas inte med', () => {
  const mk = (rise, extra = {}) => ({ closed: true, rough: false, spanDays: 40, rise, ...extra });
  const rec = S.recommend([mk(4), mk(8), mk(12), mk(16), mk(100, { rough: true }), mk(50, { closed: false }), mk(60, { spanDays: 5 })]);
  assert.equal(rec.n, 4);
  assert.equal(rec.sweepAt, 10);
  assert.equal(rec.latestAt, 13);
  assert.equal(rec.warnAt, 7);
  assert.equal(S.recommend([]), null);
});

test('daysUntil och bucketMeans', () => {
  assert.equal(S.daysUntil(2, 10, 0.5), 16);
  assert.equal(S.daysUntil(12, 10, 0.5), 0);
  assert.equal(S.daysUntil(2, 10, 0), null);
  assert.equal(S.daysUntil(2, 10, -1), null);
  const m = S.bucketMeans([{ ts: 1000, value: 10 }, { ts: 2000, value: 20 }, { ts: 901000, value: 40 }], 900);
  assert.deepEqual(m, [{ ts: 900000, value: 15 }, { ts: 1800000, value: 40 }]);
});
