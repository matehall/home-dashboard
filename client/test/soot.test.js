import test from "node:test";
import assert from "node:assert/strict";
import { sootView, segmentZone, SOOT_SEGS } from "../src/soot.js";

const base = { warnAt: 7, sweepAt: 10 };

test("segmentzoner följer gränserna", () => {
  assert.equal(segmentZone(0, 7, 10), "ok");
  assert.equal(segmentZone(6, 7, 10), "ok");
  assert.equal(segmentZone(7, 7, 10), "warn");
  assert.equal(segmentZone(9, 7, 10), "warn");
  assert.equal(segmentZone(10, 7, 10), "bad");
});

test("ok, varning och sota nu", () => {
  const ok = sootView({ ...base, status: "ok", rise: 3.2, daysLeft: 40 });
  assert.deepEqual([ok.tone, ok.lit, ok.value, ok.label], ["ok", 3, "+3", "OK · ~40 dygn"]);
  const warn = sootView({ ...base, status: "warn", rise: 8.4, daysLeft: 5.6 });
  assert.deepEqual([warn.tone, warn.lit, warn.value, warn.label], ["warn", 8, "+8", "Snart dags · ~6 dygn"]);
  const sweep = sootView({ ...base, status: "sweep", rise: 11, daysLeft: 0 });
  assert.deepEqual([sweep.tone, sweep.value, sweep.label], ["bad", "+11", "Sota nu"]);
});

test("dagar kvar visas bara när det finns och är rimligt", () => {
  assert.equal(sootView({ ...base, status: "ok", rise: 2, daysLeft: null }).label, "OK");
  assert.equal(sootView({ ...base, status: "ok", rise: 2, daysLeft: 400 }).label, "OK");
  assert.equal(sootView({ ...base, status: "warn", rise: 8, daysLeft: 0.2 }).label, "Snart dags · ~1 dygn");
});

test("okänt, saknade data och gränsfall", () => {
  for (const s of [null, undefined, { ...base, status: "unknown", rise: null }]) {
    const v = sootView(s);
    assert.deepEqual([v.tone, v.lit, v.value, v.label], ["off", 0, null, "–"]);
    assert.equal(v.zones.length, SOOT_SEGS);
  }
  assert.equal(sootView({ ...base, status: "sweep", rise: 30 }).lit, SOOT_SEGS);
  const neg = sootView({ ...base, status: "ok", rise: -1.6, daysLeft: null });
  assert.deepEqual([neg.lit, neg.value], [0, "−2"]);
  assert.equal(sootView({ ...base, status: "ok", rise: 0.2, daysLeft: null }).value, "0");
});

test("använder gränserna från servern", () => {
  const v = sootView({ warnAt: 5, sweepAt: 8, status: "ok", rise: 1 });
  assert.deepEqual(v.zones.slice(4, 9), ["ok", "warn", "warn", "warn", "bad"]);
});
