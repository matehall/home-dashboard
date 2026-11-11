import test from "node:test";
import assert from "node:assert/strict";
import { markExtremes, findExtremes } from "../src/extremes.js";

test("hittar minsta och största, utan sista (pågående) stapeln", () => {
  // sista stapeln (1) är lägst men pågående och ska inte räknas
  assert.deepEqual(markExtremes([5, 2, 9, 4, 1]), { minIdx: 1, maxIdx: 2 });
});

test("hoppar över null-värden", () => {
  assert.deepEqual(markExtremes([null, 5, 2, null, 9, 3]), { minIdx: 2, maxIdx: 4 });
});

test("färre än tre staplar med värde ger null", () => {
  assert.equal(markExtremes([5, 2, 7]), null); // bara två räknas (sista utesluts)
  assert.equal(markExtremes([null, null, 5, 2]), null);
  assert.equal(markExtremes([]), null);
});

test("alla lika ger null", () => {
  assert.equal(markExtremes([4, 4, 4, 4, 9]), null);
});

test("vid lika värden väljs första", () => {
  assert.deepEqual(markExtremes([3, 3, 8, 8, 1]), { minIdx: 0, maxIdx: 2 });
});

test("findExtremes räknar med alla värden, även sista", () => {
  assert.deepEqual(findExtremes([5, 2, 9, 4, 1]), { minIdx: 4, maxIdx: 2 });
});

test("findExtremes hoppar över null och väljer första vid lika värden", () => {
  assert.deepEqual(findExtremes([null, 3, 3, 8, 8]), { minIdx: 1, maxIdx: 3 });
});

test("findExtremes ger null för tom serie, bara null och alla lika", () => {
  assert.equal(findExtremes([]), null);
  assert.equal(findExtremes([null, null]), null);
  assert.equal(findExtremes([4, 4, 4]), null);
});
