const test = require('node:test');
const assert = require('node:assert');
const { buildSoot, cyclePeaks, dailyPeaks, median, theilSen } = require('../sootIndicator');

const MIN = 60000;
const DAY = 86400000;
const t0 = Date.parse('2026-10-25T00:00:00Z'); // sotdatum 2026-10-25

// En eldning: 70 -> 90 -> peak -> 90 -> 70, 2 min mellan punkterna (8 min totalt).
const cycle = (start, peak) => [70, 90, peak, 90, 70].map((v, i) => ({ ts: start + i * 2 * MIN, value: v }));
// perDay-dygn med n eldningar vardera, toppen = base + slope * dygn.
function season({ days, base = 100, slope = 0.5, n = 6, startDay = 1 }) {
  const out = [];
  for (let d = startDay; d < startDay + days; d += 1) {
    for (let c = 0; c < n; c += 1) out.push(...cycle(t0 + d * DAY + (8 + c * 2) * 60 * MIN, base + slope * (d - 1)));
  }
  return out;
}
const now = (daysAfter) => t0 + daysAfter * DAY + 12 * 60 * MIN; // mitt på dagen

test('cyclePeaks: hittar toppen per eldning, ignorerar spikar, luckor och för korta eldningar', () => {
  const r = [
    ...cycle(0, 105),
    { ts: 20 * MIN, value: 300 }, // mätspik ignoreras
    ...cycle(30 * MIN, 99),
    { ts: 60 * MIN, value: 95 }, { ts: 61 * MIN, value: 96 }, // kort: 2 min
    { ts: 62 * MIN, value: 70 },
  ];
  const p = cyclePeaks(r);
  assert.deepStrictEqual(p.map((x) => x.peak), [105, 99]);
  // en lucka över 30 min avslutar eldningen (topp och längd räknas fram till luckan)
  const gap = [{ ts: 0, value: 90 }, { ts: 4 * MIN, value: 100 }, { ts: 60 * MIN, value: 110 }, { ts: 62 * MIN, value: 70 }];
  assert.deepStrictEqual(cyclePeaks(gap).map((x) => x.peak), [100]);
});

test('dailyPeaks: median per dygn, dygn med för få eldningar kastas', () => {
  const r = [...season({ days: 1, n: 6 }), ...season({ days: 1, n: 2, startDay: 2 })];
  const d = dailyPeaks(cyclePeaks(r));
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].value, 100);
  assert.strictEqual(d[0].n, 6);
});

test('median och Theil-Sen', () => {
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(median([])));
  assert.strictEqual(theilSen([0, 1, 2, 3, 4], [0, 1, 2, 3, 40]), 1);
});

test('buildSoot: ok, varning och sota-nu efter stigning över baslinjen', () => {
  // baslinje = dygn 1-6 (toppar 100..102.5, median 101.25), därefter stiger toppen 0,5/dygn
  const readings = season({ days: 30 });
  const at = (d) => buildSoot(readings.filter((r) => r.ts < t0 + d * DAY), '2026-10-25', now(d));
  const early = at(10);
  assert.strictEqual(early.status, 'ok');
  assert.ok(early.rise < 7, `rise ${early.rise}`);
  const mid = at(22);
  assert.strictEqual(mid.status, 'warn');
  assert.ok(mid.rise >= 7 && mid.rise < 10, `rise ${mid.rise}`);
  const late = at(30);
  assert.strictEqual(late.status, 'sweep');
  assert.ok(late.rise >= 10);
  assert.ok(Math.abs(late.slopePerDay - 0.5) < 0.05);
});

test('buildSoot: dagar kvar till sotning räknas ur lutningen, null utan stigning', () => {
  const rising = buildSoot(season({ days: 14 }).filter((r) => r.ts < t0 + 15 * DAY), '2026-10-25', now(15));
  assert.ok(rising.daysLeft > 5 && rising.daysLeft < 25, `daysLeft ${rising.daysLeft}`);
  const flat = buildSoot(season({ days: 14, slope: 0 }).filter((r) => r.ts < t0 + 15 * DAY), '2026-10-25', now(15));
  assert.strictEqual(flat.daysLeft, null);
  assert.strictEqual(flat.status, 'ok');
});

test('buildSoot: okänt när baslinjen saknas eller strax efter sotning, och dagens dygn räknas inte', () => {
  assert.strictEqual(buildSoot([], '2026-10-25', now(10)).status, 'unknown');
  const fresh = buildSoot(season({ days: 2 }).filter((r) => r.ts < t0 + 3 * DAY), '2026-10-25', now(3));
  assert.strictEqual(fresh.status, 'unknown');
  // bara dagens (ofullständiga) dygn efter baslinjen: räknas inte med
  const only = season({ days: 7 }); // dygn 1-7
  const r = buildSoot(only.filter((x) => x.ts < t0 + 8 * DAY), '2026-10-25', t0 + 7 * DAY + 20 * 60 * MIN);
  assert.strictEqual(r.status, 'unknown');
});
