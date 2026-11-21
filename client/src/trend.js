// Trend för en brusig givare: medelvärdet av de senaste minuterna jämförs med medelvärdet av ett tidigare fönster
// (glidande medelvärden), ett dödband gör små skillnader till "stilla", och hysteres (Schmitt-trigger) hindrar att
// färgen flackar när skillnaden ligger nära gränsen. Ren funktion, ingen React.

const MIN = 60 * 1000;

// nowMs: längd på "nu"-fönstret. baseFromMs/baseToMs: basfönstret, i millisekunder bakåt från nu.
// deadband: skillnad (i givarens enhet) som krävs för att räknas som upp eller ner.
export const TREND_CFG = {
  panntemp: { nowMs: 2 * MIN, baseFromMs: 12 * MIN, baseToMs: 3 * MIN, deadband: 0.6 },
  rok_temp: { nowMs: 2 * MIN, baseFromMs: 12 * MIN, baseToMs: 3 * MIN, deadband: 3 },
  utetemperatur: { nowMs: 5 * MIN, baseFromMs: 25 * MIN, baseToMs: 10 * MIN, deadband: 0.3 },
};

const EXIT_FRACTION = 0.5; // för att lämna upp/ner räcker det att |delta| faller under hälften av dödbandet
const MIN_NOW = 1; // minsta antal värden i "nu"-fönstret
const MIN_BASE = 3; // minsta antal värden i basfönstret

function windowMean(readings, from, to) {
  let sum = 0;
  let n = 0;
  for (const r of readings) {
    if (r.ts >= from && r.ts <= to && Number.isFinite(r.value)) { sum += r.value; n++; }
  }
  return { mean: n ? sum / n : null, n };
}

// Skillnad mellan nu-medel och bas-medel, eller null om det är för lite data.
export function trendDelta(readings, now, cfg) {
  const cur = windowMean(readings, now - cfg.nowMs, now);
  const base = windowMean(readings, now - cfg.baseFromMs, now - cfg.baseToMs);
  if (cur.n < MIN_NOW || base.n < MIN_BASE) return null;
  return cur.mean - base.mean;
}

// "up" | "down" | "flat" | null (för lite data). prev är föregående resultat och ger hysteres.
export function trendOf(readings, now, cfg, prev = null) {
  const delta = trendDelta(readings, now, cfg);
  if (delta === null) return null;
  const enter = cfg.deadband;
  const exit = cfg.deadband * EXIT_FRACTION;
  if (prev === "up" && delta > -enter && delta >= exit) return "up";
  if (prev === "down" && delta < enter && delta <= -exit) return "down";
  if (delta >= enter) return "up";
  if (delta <= -enter) return "down";
  return "flat";
}
