// Elkostnad för elbil och hus per dag, månad och år.
// Pris (inkl. moms): fast 65 öre/kWh t.o.m. 2026-11-30, därefter spotpris per kvart + 0,1 + 3,75 öre.
// Zen mäter hela huset inklusive laddaren, så huset räknas som hus_effekt − ev_effekt (minst 0).
// Energi per kvart = medeleffekt (kW) × 0,25, samma metod som consumption.js.
const { stockholmDate, addDays, stockholmMidnight } = require('./consumption');

const QUARTER_MS = 15 * 60 * 1000;
const FIXED_UNTIL = '2026-12-01'; // första datum med rörligt pris (Stockholm-datum)
const FIXED_ORE = 65;
const ADDER_ORE = 0.1 + 3.75;
const HOUSE_SENSOR = process.env.CONSUMPTION_SENSOR || 'hus_effekt';
const EV_SENSOR = 'ev_effekt';
const CACHE_MS = 60 * 1000;

// Öre/kWh för en kvart, eller null om spotpris saknas när det behövs.
function priceOre(ts, spot) {
  if (stockholmDate(ts) < FIXED_UNTIL) return FIXED_ORE;
  const ore = spot.get(ts);
  return ore === undefined || ore === null ? null : ore + ADDER_ORE;
}

// evRows/houseRows: [{ ts, value (kW) }] per kvart. spot: Map ts → öre/kWh.
// Returnerar kvartar { ts, bilKwh, husKwh, ore } där bilKwh/husKwh är null om mätvärde saknas.
function buildQuarters(evRows, houseRows, spot) {
  const ev = new Map(evRows.map((r) => [r.ts, r.value]));
  const house = new Map(houseRows.map((r) => [r.ts, r.value]));
  const all = [...new Set([...ev.keys(), ...house.keys()])].sort((a, b) => a - b);
  return all.map((ts) => {
    const e = ev.get(ts);
    const h = house.get(ts);
    return {
      ts,
      bilKwh: e === undefined ? null : e * 0.25,
      husKwh: h === undefined ? null : Math.max(0, h - (e ?? 0)) * 0.25,
      ore: priceOre(ts, spot),
    };
  });
}

// Summerar kvartar per nyckel. Ger { [key]: { bil: {kwh, kr}|null, hus: {...}|null, incomplete } }.
function aggregate(quarters, keyOf) {
  const out = new Map();
  for (const q of quarters) {
    const key = keyOf(q.ts);
    const slot = out.get(key) || { bil: null, hus: null, incomplete: false };
    for (const [kind, kwh] of [['bil', q.bilKwh], ['hus', q.husKwh]]) {
      if (kwh === null) continue;
      slot[kind] = slot[kind] || { kwh: 0, kr: 0 };
      slot[kind].kwh += kwh;
      if (q.ore === null) slot.incomplete = true;
      else slot[kind].kr += (kwh * q.ore) / 100;
    }
    out.set(key, slot);
  }
  return out;
}

const round = (p) => (p ? { kwh: Math.round(p.kwh * 1000) / 1000, kr: Math.round(p.kr * 100) / 100 } : null);
const point = (key, slot) => ({ key, bil: round(slot?.bil), hus: round(slot?.hus), incomplete: slot?.incomplete ?? false });

function monthsBack(month, n) { // 'YYYY-MM' n månader bakåt
  let [y, m] = month.split('-').map(Number);
  m -= n;
  while (m < 1) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// Bygger svaret från färdiga kvartar (ren funktion, testas utan databas).
function buildReport(quarters, now) {
  const today = stockholmDate(now);
  const byDay = aggregate(quarters, (ts) => stockholmDate(ts));
  const byMonth = aggregate(quarters, (ts) => stockholmDate(ts).slice(0, 7));
  const byYear = aggregate(quarters, (ts) => stockholmDate(ts).slice(0, 4));

  const days = [];
  for (let i = 29; i >= 0; i--) { const k = addDays(today, -i); days.push(point(k, byDay.get(k))); }
  const thisMonth = today.slice(0, 7);
  const months = [];
  for (let i = 11; i >= 0; i--) { const k = monthsBack(thisMonth, i); months.push(point(k, byMonth.get(k))); }
  const thisYear = today.slice(0, 4);
  const firstYear = Math.min(Number(thisYear), ...[...byYear.keys()].map(Number));
  const years = [];
  for (let y = firstYear; y <= Number(thisYear); y++) years.push(point(String(y), byYear.get(String(y))));

  return {
    ts: now,
    today: point(today, byDay.get(today)),
    month: point(thisMonth, byMonth.get(thisMonth)),
    days, months, years,
  };
}

let cache = null;
async function getCost(now = Date.now()) {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const db = require('./db'); // laddas här så att de rena funktionerna kan testas utan SQLite
  const from = stockholmMidnight(`${Number(stockholmDate(now).slice(0, 4)) - 4}-01-01`);
  const to = stockholmMidnight(addDays(stockholmDate(now), 1));
  const area = (process.env.ELECTRICITY_AREA || '').toUpperCase();
  const [ev, house, prices] = await Promise.all([
    db.getQuarterAverages(EV_SENSOR, from, to),
    db.getQuarterAverages(HOUSE_SENSOR, from, to),
    area ? db.getPrices(area, from, to) : [],
  ]);
  const spot = new Map(prices.map((p) => [p.ts, p.ore]));
  const value = buildReport(buildQuarters(ev, house, spot), now);
  cache = { at: now, value };
  return value;
}

module.exports = { getCost, priceOre, buildQuarters, aggregate, buildReport, FIXED_ORE, ADDER_ORE, QUARTER_MS };
