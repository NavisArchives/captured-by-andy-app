import { test } from "node:test";
import assert from "node:assert/strict";
import { humanName, placeName } from "../src/lib/humanName.ts";

test("a named clip gives its place and what happens", () => {
  assert.deepEqual(humanName("STRASBOURG_2026-10-25_51_ANDY-TALKING-OUTSIDE-GLASS-BUILDING-2.MP4"), { place: "Strasbourg", what: "Andy talking outside glass building" });
  assert.deepEqual(humanName("164_THAILAND_WRITING-NOTES.MP4"), { place: null, what: "Writing notes" });
});
test("camera names say nothing", () => {
  assert.deepEqual(humanName("DSC07519.JPG"), { place: null, what: null });
  assert.deepEqual(humanName("DJI_20261111163007_0143_D.MP4"), { place: null, what: null });
});
test("place names in people's case", () => {
  assert.equal(placeName("SRI LANKA"), "Sri Lanka");
  assert.equal(placeName("CAPE TOWN"), "Cape Town");
});
