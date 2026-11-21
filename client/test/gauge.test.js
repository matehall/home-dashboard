import test from "node:test";
import assert from "node:assert/strict";
import { fraction, litCount, arcTicks, gaugeMaxKw, stackPath } from "../src/gauge.js";

test("fraction klämmer till 0..1 och ger null utan värde", () => {
  assert.equal(fraction(45, 0, 90), 0.5);
  assert.equal(fraction(-5, 0, 90), 0);
  assert.equal(fraction(200, 0, 90), 1);
  assert.equal(fraction(0, -25, 35), 25 / 60);
  assert.equal(fraction(null, 0, 90), null);
  assert.equal(fraction(undefined, 0, 90), null);
});

test("litCount tänder minst ett segment över noll", () => {
  assert.equal(litCount(0, 40), 0);
  assert.equal(litCount(null, 40), 0);
  assert.equal(litCount(0.001, 40), 1);
  assert.equal(litCount(0.5, 40), 20);
  assert.equal(litCount(1, 40), 40);
});

test("arcTicks: rätt antal, första rakt upp och sista vid slutvinkeln", () => {
  const t = arcTicks(3, 0, 180, 10, 20);
  assert.equal(t.length, 3);
  assert.ok(Math.abs(t[0].x2) < 1e-9 && Math.abs(t[0].y2 + 20) < 1e-9); // 0 grader = uppåt
  assert.ok(Math.abs(t[2].x2) < 1e-9 && Math.abs(t[2].y2 - 20) < 1e-9); // 180 grader = nedåt
});

test("gaugeMaxKw: trefas 16 A är cirka 11 kW, enfas 16 A cirka 3,7 kW, fallback 11", () => {
  assert.ok(Math.abs(gaugeMaxKw({ current_limit_a: 16, circuit_fuse_a: 20, cable_current_limit_a: 32, phase_charging: 0 }) - 11.04) < 0.01);
  assert.ok(Math.abs(gaugeMaxKw({ current_limit_a: 16, phase_charging: 1 }) - 3.68) < 0.01);
  assert.equal(gaugeMaxKw({}), 11);
  assert.equal(gaugeMaxKw(null), 11);
});

test("stackPath: ett segment per tänd rad och tomt utan värde", () => {
  assert.equal(stackPath(0, 5, 100, 10, 0), "");
  assert.equal((stackPath(0, 5, 100, 10, 0.5).match(/M/g) || []).length, 5);
  assert.equal((stackPath(0, 5, 100, 10, 1).match(/M/g) || []).length, 10);
});
