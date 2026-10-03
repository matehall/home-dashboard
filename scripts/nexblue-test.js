// Testar inloggning mot NexBlue och skriver ut laddboxens status. Rör inte databasen.
//
//   cd server && npm run test:nexblue
//   npm run test:nexblue -- --raw     (visa hela svaret, inkl. serienummer)
//   npm run test:nexblue -- --debug   (visa felsvarets innehåll vid fel på statusanropet)
//
// Uppgifter läses från NEXBLUE_USERNAME / NEXBLUE_PASSWORD (miljö eller server/.env).
// Saknas de frågar skriptet; lösenordet visas inte när du skriver. Tokens skrivs aldrig ut.
const path = require('path');
const readline = require('readline');

const SERVER_DIR = path.join(__dirname, '..', 'server');
// dotenv ligger i server/node_modules, inte bredvid scriptet.
require(require.resolve('dotenv', { paths: [SERVER_DIR] })).config({ path: path.join(SERVER_DIR, '.env') });

const BASE_URL = (process.env.NEXBLUE_API_BASE_URL || 'https://api.nexblue.com/third_party').replace(/\/$/, '');
const RAW = process.argv.includes('--raw');
const DEBUG = process.argv.includes('--debug');

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

async function request(method, urlPath, { body, token } = {}) {
  // Content-Type bara med kropp: NexBlue svarar annars 400 "Error Parsing JSON" på GET.
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${BASE_URL}${urlPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`Kan inte nå ${BASE_URL} (${err.cause?.code || err.message})`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* inte JSON */ }
  if (!res.ok) {
    const code = json && json.code !== undefined ? ` (felkod ${json.code})` : '';
    const err = new Error(`HTTP ${res.status} på ${method} ${urlPath}${code}`);
    err.body = text;
    throw err;
  }
  return json;
}

const mask = (sn) => (sn.length > 4 ? `${'*'.repeat(sn.length - 4)}${sn.slice(-4)}` : '****');

async function main() {
  const username = process.env.NEXBLUE_USERNAME || (await ask('Användarnamn: '));
  const password = process.env.NEXBLUE_PASSWORD || (await ask('Lösenord: ', { hidden: true }));
  if (!username || !password) throw new Error('Användarnamn och lösenord krävs');

  console.log(`Bas-URL: ${BASE_URL}`);
  console.log('1. Loggar in…');
  const login = await request('POST', '/openapi/account/login', {
    body: { username, password, account_type: 0 },
  });
  if (!login || !login.access_token) throw new Error('Inloggningen gav ingen access_token');
  console.log(`   OK (token giltig i ${login.expires_in ?? '?'} s, refresh_token: ${login.refresh_token ? 'ja' : 'nej'})`);

  console.log('2. Hämtar laddboxar…');
  const list = await request('GET', '/openapi/chargers', { token: login.access_token });
  const chargers = (list && list.data) || [];
  console.log(`   ${chargers.length} laddbox(ar)`);
  if (!chargers.length) return;

  for (const charger of chargers) {
    const sn = String(charger.serial_number);
    console.log(`3. Status för ${RAW ? sn : mask(sn)} (roll: ${charger.role ?? '–'})…`);
    try {
      const status = await request('GET', `/openapi/chargers/${sn}/cmd/status`, { token: login.access_token });
      console.log(JSON.stringify(status, null, 2));
    } catch (err) {
      const hide = (text) => (RAW ? text : text.split(sn).join(mask(sn)));
      console.log(`   Misslyckades: ${hide(err.message)}`);
      if (DEBUG && err.body) console.log(`   Svarskropp: ${hide(err.body.slice(0, 500))}`);
    }
  }
}

main().catch((err) => {
  console.error(`\nFel: ${err.message}`);
  process.exitCode = 1;
});
