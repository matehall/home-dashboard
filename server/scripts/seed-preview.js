// Fyller en tom databas med påhittad effekthistorik (hus_effekt och ev_effekt per kvart) så att kostnadsdiagrammen
// har något att visa i en förhandsvisning. Kör i containern, se scripts/preview.sh. Rör aldrig riktig data:
// vägrar köra om databasen redan har mätvärden.
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new sqlite3.Database(path.join(DATA_DIR, 'dashboard.db'));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));
const get = (sql) => new Promise((res, rej) => db.get(sql, (e, r) => (e ? rej(e) : res(r))));

const QUARTER_MS = 15 * 60 * 1000;
const DAYS_BACK = 430; // drygt ett år, så att månads- och årsdiagrammen får flera staplar

// Deterministisk slump så att förhandsvisningen ser lika ut varje gång.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  await run('CREATE TABLE IF NOT EXISTS readings (id INTEGER PRIMARY KEY AUTOINCREMENT, sensor TEXT NOT NULL, topic TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL DEFAULT \'\', ts INTEGER NOT NULL)');
  await run('CREATE INDEX IF NOT EXISTS idx_sensor_ts ON readings (sensor, ts)');
  const existing = await get('SELECT COUNT(*) AS n FROM readings');
  if (existing.n > 0) throw new Error(`databasen har redan ${existing.n} mätvärden, avbryter`);

  const rand = mulberry32(42);
  const end = Math.floor(Date.now() / QUARTER_MS) * QUARTER_MS;
  const start = end - DAYS_BACK * 24 * 3600 * 1000;
  const dayFactor = new Map();
  await run('BEGIN');
  const insert = db.prepare('INSERT INTO readings (sensor, topic, value, unit, ts) VALUES (?, ?, ?, ?, ?)');
  let rows = 0;
  for (let ts = start; ts < end; ts += QUARTER_MS) {
    const d = new Date(ts);
    const dayKey = d.toISOString().slice(0, 10);
    if (!dayFactor.has(dayKey)) {
      let f = 0.7 + rand() * 0.7; // vardagsvariation
      if (rand() < 0.04) f = 0.35; // enstaka mycket låg dag (bortrest)
      if (rand() < 0.04) f = 1.9; // enstaka mycket hög dag (gäster, tvätt)
      dayFactor.set(dayKey, f);
    }
    const month = d.getUTCMonth();
    const season = 1 + 0.6 * Math.cos(((month - 0.5) / 12) * 2 * Math.PI); // dyrast vinter
    const h = (d.getUTCHours() + 1) % 24;
    const base = 0.45 + (h >= 6 && h < 9 ? 0.9 : 0) + (h >= 17 && h < 22 ? 1.3 : 0) + rand() * 0.25;
    const ev = dayKey.charCodeAt(9) % 3 === 0 && (h >= 22 || h < 5) ? 3.6 : 0; // laddar var tredje natt
    const house = (base * season * dayFactor.get(dayKey)) + ev;
    insert.run('hus_effekt', 'preview/hus', house, 'kW', ts + 60000);
    insert.run('ev_effekt', 'preview/ev', ev, 'kW', ts + 60000);
    rows += 2;
  }
  await new Promise((res, rej) => insert.finalize((e) => (e ? rej(e) : res())));
  await run('COMMIT');
  console.log(`seed klar: ${rows} rader, ${DAYS_BACK} dagar bakåt`);
}

main().catch((e) => { console.error(e.message); process.exit(1); }).finally(() => db.close());
