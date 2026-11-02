// Testar NexBlue-portalens API (my.nexblue.com) för Zen-lastbalanseraren: förbrukning per minut,
// timme, dag, månad och år samt timtoppar. Skrivskyddat; rör inte databasen och anropar aldrig
// clear_detector_energy eller PUT /detector.
//
//   cd server && npm run test:nexblue-portal -- --sn <detektor-id> [--date 2026-11-01]
//
// Uppgifter läses från NEXBLUE_PORTAL_USERNAME / NEXBLUE_PORTAL_PASSWORD (miljö eller server/.env).
// Det är portalkontot (my.nexblue.com), inte NEXBLUE_USERNAME/NEXBLUE_PASSWORD som gäller
// third_party-API:t för laddboxen och kan vara ett annat konto. Saknas de frågar skriptet;
// lösenordet visas inte när du skriver. Detektor-ID anges med --sn eller
// NEXBLUE_DETECTOR_SN. Token, lösenordshash och detektor-ID skrivs aldrig ut (ID maskas).
//
// Inloggning: POST /accounts/get_token med md5(base64(lösenord)) som lösenord, så som portalen gör.
// IdToken skickas sedan i Authorization utan "Bearer". En inloggning här kan tänkas logga ut din
// webbsession i portalen.
const crypto = require('crypto');
const path = require('path');
const readline = require('readline');

const SERVER_DIR = path.join(__dirname, '..', 'server');
// dotenv ligger i server/node_modules, inte bredvid scriptet. Valfritt: utan det används bara
// miljövariablerna (eller frågorna), så skriptet går att köra med enbart `node` före `npm install`.
try {
  require(require.resolve('dotenv', { paths: [SERVER_DIR] })).config({ path: path.join(SERVER_DIR, '.env') });
} catch { /* dotenv ej installerat */ }

const BASE_URL = 'https://api.nexblue.com';
const TZ = 'Europe/Stockholm';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// Portalens "kryptering" av lösenordet: md5(base64(lösenord)) som hex.
const portalPassword = (pw) => crypto.createHash('md5').update(Buffer.from(pw.trim()).toString('base64')).digest('hex');

const mask = (sn) => (sn.length > 4 ? `${'*'.repeat(sn.length - 4)}${sn.slice(-4)}` : '****');

// Unix-sekunder för 00:00 svensk tid ett visst datum (hanterar sommar-/vintertid).
function localMidnight(y, m, d) {
  const utcGuess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcGuess)).reduce((o, p) => ({ ...o, [p.type]: Number(p.value) }), {});
  const asLocal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return (utcGuess - (asLocal - utcGuess)) / 1000;
}

function defaultDate() {
  const y = new Date(Date.now() - 86400000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(y); // YYYY-MM-DD
}

async function post(urlPath, body, token) {
  const headers = { 'Content-Type': 'application/json;charset=UTF-8' };
  if (token) headers.Authorization = token; // råa IdToken, utan "Bearer"
  let res;
  try {
    res = await fetch(`${BASE_URL}${urlPath}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new Error(`Kan inte nå ${BASE_URL} (${err.cause?.code || err.message})`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* inte JSON */ }
  if (!res.ok) {
    const code = json && json.code !== undefined ? ` (felkod ${json.code})` : '';
    const msg = json && json.message ? `: ${String(json.message).split('\n')[0]}` : '';
    throw new Error(`HTTP ${res.status} på ${urlPath.replace(/\/detector\/[^/]+/, '/detector/<sn>')}${code}${msg}`);
  }
  return json;
}

const kwh = (v) => `${Number(v).toFixed(2)} kWh`;
const sum = (rows, key) => rows.reduce((s, r) => s + Number(r[key] || 0), 0);
const hhmm = (ts) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));

async function step(title, fn) {
  console.log(`\n${title}`);
  try { await fn(); } catch (err) { console.log(`   Misslyckades: ${err.message}`); }
}

async function main() {
  const username = process.env.NEXBLUE_PORTAL_USERNAME || (await ask('Användarnamn: '));
  const password = process.env.NEXBLUE_PORTAL_PASSWORD || (await ask('Lösenord: ', { hidden: true }));
  const sn = arg('sn') || process.env.NEXBLUE_DETECTOR_SN || (await ask('Detektor-ID (--sn): '));
  if (!username || !password || !sn) throw new Error('Användarnamn, lösenord och detektor-ID krävs');

  const date = arg('date') || defaultDate();
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) throw new Error('--date ska vara YYYY-MM-DD');
  const start = localMidnight(y, m, d);
  const end = start + 86400;
  const base = `/detector/${encodeURIComponent(sn)}`;

  console.log(`Bas-URL: ${BASE_URL}  Detektor: ${mask(sn)}  Datum: ${date} (${TZ})`);

  console.log('1. Loggar in…');
  const login = await post('/accounts/get_token', {
    username: username.trim(), password: portalPassword(password), confirm_password: '', code: '',
  });
  if (!login || !login.IdToken) throw new Error('Inloggningen gav ingen IdToken');
  console.log(`   OK (giltig i ${login.ExpiresIn ?? '?'} s, refresh-token: ${login.RefreshToken ? 'ja' : 'nej'})`);
  const token = login.IdToken;

  await step('2. Minutdata (get_detector_data_log)…', async () => {
    const { result } = await post(`${base}/get_detector_data_log`, { start_timestamp: String(start), end_timestamp: String(end) }, token);
    if (!result.length) return console.log('   Inga punkter');
    const first = result[0];
    const last = result[result.length - 1];
    const peak = result.reduce((a, b) => (b.power > a.power ? b : a));
    console.log(`   ${result.length} punkter, ${hhmm(first.timestamp)}–${hhmm(last.timestamp)}`);
    console.log(`   Mätare: ${first.energy.toFixed(1)} → ${last.energy.toFixed(1)} kWh (diff ${kwh(last.energy - first.energy)}; mätaren stegar bara en gång per timme, använd effekt för kvartar)`);
    console.log(`   Effekt: max ${peak.power.toFixed(2)} kW kl ${hhmm(peak.timestamp)}, senaste ${last.power.toFixed(2)} kW`);
    console.log(`   Fält: ${Object.keys(first).filter((k) => k !== 'serial_number').join(', ')}`);
  });

  await step('3. Energi per timme (get_day_static_log)…', async () => {
    const { result } = await post(`${base}/get_day_static_log`, { start_timestamp: start, end_timestamp: end }, token);
    // Stämpeln HH:59 hör till klockslaget HH-1 (verifierat mot effektdata): 00:59 = 23–24 föregående dygn.
    // Dygnet täcker alltså timme 23 dagen före till och med timme 22, inte 00–23. Etikett = klockslag.
    const hourOf = (ts) => hhmm(ts - 3600).slice(0, 2);
    console.log(`   ${result.length} timmar, summa ${kwh(sum(result, 'energy'))} (se kommentar: dygnet är förskjutet en timme)`);
    console.log(`   ${result.map((r) => `${hourOf(r.timestamp)}h ${Number(r.energy).toFixed(2)}`).join(' | ')}`);
  });

  await step(`4. Energi per dag i månaden (get_monthly_static_log ${y}-${m})…`, async () => {
    const { result } = await post(`${base}/get_monthly_static_log`, { start_timestamp: start, end_timestamp: end, year: y, month: m }, token);
    console.log(`   ${result.length} poster, summa ${kwh(sum(result, 'energy'))} (index 0 = dag 1)`);
  });

  await step(`5. Energi per månad (get_year_static_log ${y})…`, async () => {
    const { result } = await post(`${base}/get_year_static_log`, { start_timestamp: start, end_timestamp: end, year: y }, token);
    console.log(`   ${result.map((r, i) => `${i + 1}:${Number(r.energy).toFixed(0)}`).join(' ')}  (månad:kWh)`);
  });

  // OBS: svaret verkar vara max per dag-i-månaden över flera månader och månadsvärdet följer inte `month`.
  // Beräkna toppar från timdata (steg 3) i stället. energy_max_hour = klockslaget (lokal tid).
  await step(`6. Dygnstoppar per timme (get_month_peak_static ${y}-${m}, OPÅLITLIG)…`, async () => {
    const { result } = await post(`${base}/get_month_peak_static`, { year: y, month: m }, token);
    const top = result.map((r, i) => ({ dag: i + 1, ...r })).sort((a, b) => b.energy_max - a.energy_max).slice(0, 3);
    console.log(`   Tre högsta timmarna: ${top.map((r) => `dag ${r.dag} kl ${r.energy_max_hour} ${Number(r.energy_max).toFixed(2)} kWh`).join(' | ')}`);
  });
}

main().catch((err) => {
  console.error(`\nFel: ${err.message}`);
  process.exitCode = 1;
});
