const test = require('node:test');
const assert = require('node:assert');
const { priceOre, buildQuarters, buildReport } = require('../cost');
const { stockholmMidnight } = require('../consumption');

const Q = 15 * 60 * 1000;

test('fast pris t.o.m. 2026-11-30, rörligt från 1/12 (Stockholm-datum)', () => {
  const lastFixed = Date.UTC(2026, 10, 30, 22, 45); // 23:45 lokal tid 30/11
  const firstVar = Date.UTC(2026, 10, 30, 23, 0);   // 00:00 lokal tid 1/12
  const spot = new Map([[firstVar, 100]]);
  assert.strictEqual(priceOre(lastFixed, spot), 65);
  assert.ok(Math.abs(priceOre(firstVar, spot) - 103.85) < 1e-9);
  assert.strictEqual(priceOre(firstVar + Q, spot), null); // spotpris saknas
});

test('hus = hus - bil, minst 0, bil null utan mätvärde', () => {
  const ts = Date.UTC(2026, 10, 10, 12);
  const [a] = buildQuarters([{ ts, value: 4 }], [{ ts, value: 6 }], new Map());
  assert.strictEqual(a.bilKwh, 1);
  assert.strictEqual(a.husKwh, 0.5);
  const [b] = buildQuarters([{ ts, value: 7 }], [{ ts, value: 6 }], new Map());
  assert.strictEqual(b.husKwh, 0);
  const [c] = buildQuarters([], [{ ts, value: 2 }], new Map());
  assert.strictEqual(c.bilKwh, null);
});

test('rapport: dagskostnad med fast pris', () => {
  const now = Date.UTC(2026, 10, 10, 12);
  const start = stockholmMidnight('2026-11-10');
  const rows = Array.from({ length: 4 }, (_, i) => ({ ts: start + i * Q, value: 4 })); // 4 kW i en timme = 4 kWh
  const r = buildReport(buildQuarters([], rows, new Map()), now);
  assert.strictEqual(r.today.hus.kwh, 4);
  assert.strictEqual(r.today.hus.kr, 2.6);
  assert.strictEqual(r.today.bil, null);
  assert.strictEqual(r.days.length, 30);
  assert.strictEqual(r.months.length, 12);
  assert.strictEqual(r.month.hus.kr, 2.6);
});

test('DST-dygn har 92 respektive 100 kvartar', () => {
  assert.strictEqual((stockholmMidnight('2026-03-30') - stockholmMidnight('2026-03-29')) / Q, 92);
  assert.strictEqual((stockholmMidnight('2026-10-26') - stockholmMidnight('2026-10-25')) / Q, 100);
});

test('ofullständigt flaggas när spotpris saknas efter 1/12', () => {
  const ts = stockholmMidnight('2026-12-02');
  const r = buildReport(buildQuarters([], [{ ts, value: 4 }], new Map()), ts + 3600000);
  assert.strictEqual(r.today.incomplete, true);
  assert.strictEqual(r.today.hus.kr, 0);
});
