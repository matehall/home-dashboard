import test from "node:test";
import assert from "node:assert/strict";
import { angleToIndex } from "../src/clockMath.js";

const N = 96; // 24 h i kvartar, 3,75 grader per kvart

test("rakt upp (midnatt) är första kvarten", () => {
  assert.equal(angleToIndex(0, -50, N), 0);
});

test("rakt åt höger är 06:00 (kvart 24)", () => {
  assert.equal(angleToIndex(50, 0, N), 24);
});

test("rakt ned är 12:00 (kvart 48)", () => {
  assert.equal(angleToIndex(0, 50, N), 48);
});

test("rakt åt vänster är 18:00 (kvart 72)", () => {
  assert.equal(angleToIndex(-50, 0, N), 72);
});

test("strax före midnatt är sista kvarten", () => {
  assert.equal(angleToIndex(-0.1, -50, N), 95);
});

test("kvartsgräns: precis över respektive under 3,75 grader", () => {
  const r = 100;
  const at = (deg) => angleToIndex(r * Math.sin((deg * Math.PI) / 180), -r * Math.cos((deg * Math.PI) / 180), N);
  assert.equal(at(3.7), 0);
  assert.equal(at(3.8), 1);
});

test("fungerar med färre kvartar (t.ex. 92 vid sommartid)", () => {
  assert.equal(angleToIndex(0, 50, 92), 46);
});
