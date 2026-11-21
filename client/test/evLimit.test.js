import test from "node:test";
import assert from "node:assert/strict";
import { evLimitReason } from "../src/evLimit.js";

const base = { charging_state: 2, current_limit_a: 16, circuit_fuse_a: 20, cable_current_limit_a: 32, current_a: [15.8, 15.9, 15.8] };

test("ingen data eller vilande box ger ingen orsak", () => {
  assert.equal(evLimitReason(null), null);
  assert.equal(evLimitReason({ ...base, charging_state: 1 }), null);
});

test("laddar vid lägsta gränsen: pekar ut gränsen", () => {
  assert.equal(evLimitReason(base).text, "Begränsad av inställd gräns 16 A");
});

test("kabeln är lägst", () => {
  assert.equal(evLimitReason({ ...base, cable_current_limit_a: 13, current_a: [12.9, 13, 13] }).text, "Begränsad av kabelns max 13 A");
});

test("bilen drar mindre än gränsen", () => {
  assert.equal(evLimitReason({ ...base, current_a: [8, 8, 8] }).text, "Bilen tar 8 A (gräns 16 A)");
});

test("lastbalansering och väntlägen", () => {
  assert.match(evLimitReason({ ...base, charging_state: 5 }).text, /Lastbalansering/);
  assert.match(evLimitReason({ ...base, charging_state: 7 }).text, /bilen/);
});
