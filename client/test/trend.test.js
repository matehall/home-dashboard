import test from "node:test";
import assert from "node:assert/strict";
import { trendOf, trendDelta, TREND_CFG } from "../src/trend.js";

const MIN = 60000;
const cfg = TREND_CFG.panntemp; // dödband 0,6
const NOW = 1_000_000_000;

// Serie med ett värde var 11:e sekund de senaste 15 minuterna, värdet ges av fn(minuter bakåt).
const series = (fn, minutes = 15) => {
  const out = [];
  for (let t = minutes * MIN; t >= 0; t -= 11000) out.push({ ts: NOW - t, value: fn(t / MIN) });
  return out;
};

test("stigande serie ger up, fallande down", () => {
  assert.equal(trendOf(series((m) => 70 - 0.5 * m), NOW, cfg), "up");
  assert.equal(trendOf(series((m) => 70 + 0.5 * m), NOW, cfg), "down");
});

test("stilla serie med brus ger flat", () => {
  let i = 0;
  const noisy = series(() => 70 + ((i++ % 5) - 2) * 0.1); // +-0,2 grader
  assert.equal(trendOf(noisy, NOW, cfg), "flat");
});

test("enstaka avvikande värde flyttar inte trenden (medelvärde)", () => {
  const s = series(() => 70);
  s[s.length - 1] = { ts: NOW, value: 75 }; // ett enda utskott i nu-fönstret
  assert.equal(trendOf(s, NOW, cfg), "flat");
});

test("hysteres: delta strax under dödbandet behåller upp, men flat startar inte som upp", () => {
  const delta = (d) => series((m) => 70 - (d / 6.5) * m);
  const small = delta(0.4); // under dödband 0,6 men över hälften (0,3)
  assert.equal(trendOf(small, NOW, cfg, null), "flat");
  assert.equal(trendOf(small, NOW, cfg, "up"), "up");
  assert.equal(trendOf(delta(0.1), NOW, cfg, "up"), "flat"); // under hälften släpper den
});

test("hysteres: motsatt riktning kräver fullt dödband", () => {
  const s = series((m) => 70 + (0.4 / 6.5) * m); // svagt fallande
  assert.equal(trendOf(s, NOW, cfg, "up"), "flat");
  assert.equal(trendOf(series((m) => 70 + (1 / 6.5) * m), NOW, cfg, "up"), "down");
});

test("för lite data ger null", () => {
  assert.equal(trendOf([], NOW, cfg), null);
  assert.equal(trendOf(series(() => 70, 1), NOW, cfg), null); // saknar basfönstret
  assert.equal(trendDelta([], NOW, cfg), null);
});

test("olika dödband per givare", () => {
  const s = series((m) => 100 - 0.4 * m); // cirka 2,6 grader över 6,5 min
  assert.equal(trendOf(s, NOW, TREND_CFG.panntemp), "up");
  assert.equal(trendOf(s, NOW, TREND_CFG.rok_temp), "flat"); // rök har dödband 3
});
