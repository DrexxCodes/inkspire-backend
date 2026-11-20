import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBuckets, fillSeries, MAX_POINTS } from "../src/modules/analytics/analytics.range.js";
import { dayKey, monthKey, yearKey } from "../src/utils/time.js";

const NOW = new Date("2026-03-02T15:30:00Z");

test("daily buckets are contiguous and cross month boundaries", () => {
  assert.deepEqual(buildBuckets("daily", 4, NOW), ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
});

test("daily buckets handle leap years", () => {
  const leap = buildBuckets("daily", 3, new Date("2028-03-01T00:00:00Z"));
  assert.deepEqual(leap, ["2028-02-28", "2028-02-29", "2028-03-01"]);
});

test("monthly buckets cross year boundaries and use the first of the month", () => {
  assert.deepEqual(buildBuckets("monthly", 4, NOW), ["2025-12-01", "2026-01-01", "2026-02-01", "2026-03-01"]);
});

test("yearly buckets", () => {
  assert.deepEqual(buildBuckets("yearly", 3, NOW), ["2024", "2025", "2026"]);
});

test("the number of points is clamped to a safe range", () => {
  assert.equal(buildBuckets("daily", 100000, NOW).length, MAX_POINTS.daily);
  assert.equal(buildBuckets("monthly", 0, NOW).length, 1);
  assert.equal(buildBuckets("yearly", -5, NOW).length, 1);
});

test("fillSeries zero fills gaps and converts numeric strings from the database", () => {
  const buckets = buildBuckets("daily", 3, NOW);
  const rows = [{ bucket: "2026-03-01", signups: "5", views: 120 }];
  const series = fillSeries(buckets, rows);
  assert.equal(series.length, 3);
  assert.equal(series[0]!.signups, 0);
  assert.equal(series[1]!.signups, 5);
  assert.equal(series[1]!.views, 120);
  assert.equal(series[2]!.likes, 0);
});

test("fillSeries only reports the requested metrics", () => {
  const series = fillSeries(["2026"], [{ bucket: "2026", signups: 9, likes: 4 }], ["likes"]);
  assert.equal(series[0]!.likes, 4);
  assert.equal(series[0]!.signups, 0);
});

test("bucket keys written by the aggregator match the keys the reader builds", () => {
  const at = new Date("2026-11-17T23:59:59Z");
  assert.equal(buildBuckets("daily", 1, at)[0], dayKey(at));
  assert.equal(buildBuckets("monthly", 1, at)[0], monthKey(at));
  assert.equal(buildBuckets("yearly", 1, at)[0], String(yearKey(at)));
});

test("a late evening UTC event lands in the right UTC day", () => {
  assert.equal(dayKey(new Date("2026-12-31T23:59:59Z")), "2026-12-31");
  assert.equal(monthKey(new Date("2026-12-31T23:59:59Z")), "2026-12-01");
  assert.equal(yearKey(new Date("2026-12-31T23:59:59Z")), 2026);
});
