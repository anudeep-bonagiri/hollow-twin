// Task 6: surface truth. Verdict from sourced limits, a public record of every change, and a ranked first wave.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { makeServer, ROOT } = require("./helper");

const limits = JSON.parse(fs.readFileSync(path.join(ROOT, "shared/limits.json"), "utf8")).limits;
const s = makeServer({ RATE_LIMIT: "1000" }); // one scout posts many readings a second in these tests
before(() => s.start());
after(() => s.cleanup());
// Every scout reading is stamped later than the one before it. The API picks the latest reading by its `time`,
// so two posts inside the same few milliseconds must not be left to the speed of the machine running the tests.
let clock = Date.now();
const scout = (values, source, ms = 0) => {
  clock = Math.max(clock + 1, Date.now() + ms);
  return s.post("/ingest", s.R("surface-01", "surface", "surface", values, clock, source ? { source } : {}));
};
const SAFE = { co2_ppm: 430, o2_pct: 20.9, temp_c: 18, pm25_ugm3: 12, radiation_usv_h: 0.2 };

test("no readings, then some readings: 'not enough data' until the contract's three readings are all there, never a guess", async () => {
  let v = await s.get("/surface");
  assert.strictEqual(v.verdict, "not enough data");
  assert.deepStrictEqual(v.missing.sort(), ["co2_ppm", "radiation_usv_h", "temp_c"], "the contract's three readings are required");
  assert.deepStrictEqual(v.not_measured.sort(), ["o2_pct", "pm25_ugm3"], "oxygen and PM2.5 are optional");
  assert.strictEqual(v.source, null);
  await scout({ co2_ppm: 430, temp_c: 18 });
  v = await s.get("/surface");
  assert.strictEqual(v.verdict, "not enough data", "a missing required reading is never filled in with a guess");
  assert.deepStrictEqual(v.missing, ["radiation_usv_h"]);
  assert.match(v.reasons.join(" | "), /^no radiation reading yet$/);
  await scout({ co2_ppm: 430, temp_c: 18, o2_pct: 20.9, pm25_ugm3: 10 }, undefined, 1);
  v = await s.get("/surface");
  assert.strictEqual(v.verdict, "not enough data", "optional readings do not stand in for a required one");
  await scout({ radiation_usv_h: 900 }, undefined, 2); // lethal: a real verdict, even with no further optional readings
  v = await s.get("/surface");
  assert.strictEqual(v.verdict, "stay underground");
  assert.deepStrictEqual(v.readings.find((r) => r.reading === "o2_pct").required, false);
});

test("the contract's three readings inside their limits: suits OK; the optional ones are listed as not measured without blocking it", async () => {
  await scout({ co2_ppm: 430, temp_c: 17.5, radiation_usv_h: 0.31 }, undefined, 3);
  let v = await s.get("/surface");
  assert.strictEqual(v.verdict, "suits OK");
  assert.deepStrictEqual([v.missing, v.not_measured.sort()], [[], []], "oxygen and PM2.5 were measured earlier in this test file");
  const fresh = makeServer(); await fresh.start();
  try {
    await fresh.post("/ingest", fresh.R("surface-01", "surface", "surface", { co2_ppm: 430, temp_c: 17.5, radiation_usv_h: 0.31 }));
    v = await fresh.get("/surface");
    assert.strictEqual(v.verdict, "suits OK");
    assert.deepStrictEqual([v.missing, v.not_measured.sort()], [[], ["o2_pct", "pm25_ugm3"]]);
    assert.strictEqual(v.readings.find((r) => r.reading === "o2_pct").status, "not measured");
    assert.match(v.reasons[v.reasons.length - 1], /^not measured: oxygen, PM2\.5 \(optional readings; the verdict rests on what was measured\)$/);
    assert.ok(v.reasons.slice(0, -1).every((r) => /is inside every limit/.test(r)) && v.reasons.length === 4);
  } finally { await fresh.cleanup(); }
  await scout(SAFE, undefined, 4);
  v = await s.get("/surface");
  assert.strictEqual(v.verdict, "suits OK");
  assert.deepStrictEqual(v.missing, []);
  assert.strictEqual(v.readings.length, 5);
  for (const r of v.readings) {
    assert.strictEqual(r.status, "ok", r.reading);
    assert.strictEqual(r.value, SAFE[r.reading]);
    assert.ok(r.limits.length >= 1 && r.limits.every((l) => l.source && /^https:/.test(l.url)), `${r.reading} carries sourced limits`);
    assert.match(r.reason, /is inside every limit/);
  }
  assert.strictEqual(v.source, "simulated");
});

test("each limit, one at a time: the verdict (one of the four return options) and its exact reason", async () => {
  const L = (k) => limits[k].value;
  const cases = [
    [{ radiation_usv_h: 2.1 }, "sealed outposts needed", /^radiation 2\.1 µSv\/h is above 1 µSv\/h \(IAEA, Operational Intervention Levels/],
    [{ radiation_usv_h: L("surface_radiation_domes_usv_h") }, "suits OK", /inside every limit/],
    [{ radiation_usv_h: L("surface_radiation_stay_usv_h") + 5 }, "stay underground", /radiation 30 µSv\/h is above 25 µSv\/h \(IAEA/],
    [{ co2_ppm: L("surface_co2_domes_ppm") + 1 }, "sealed domes needed", /CO2 5001 ppm is above 5000 ppm \(OSHA PEL/],
    [{ co2_ppm: L("surface_co2_stay_ppm") }, "stay underground", /CO2 40000 ppm is at or above 40000 ppm \(NIOSH, Immediately Dangerous/],
    [{ o2_pct: 19.4 }, "sealed domes needed", /oxygen 19\.4 % is below 19\.5 % \(OSHA 29 CFR 1910\.146/],
    [{ o2_pct: 24 }, "sealed domes needed", /oxygen 24 % is above 23\.5 % \(OSHA/],
    [{ temp_c: 41 }, "sealed domes needed", /temperature 41 C is at or above 39\.4 C \(US National Weather Service/],
    [{ temp_c: 55 }, "sealed outposts needed", /temperature 55 C is at or above 51\.7 C \(US National Weather Service/],
    [{ temp_c: -30 }, "sealed outposts needed", /temperature -30 C is at or below -28\.3 C \(US National Weather Service, wind chill/],
    [{ pm25_ugm3: 300 }, "sealed domes needed", /PM2\.5 300 µg\/m3 is at or above 225\.5 µg\/m3 \(US EPA/],
  ];
  for (const [change, verdict, reason] of cases) {
    await scout({ ...SAFE, ...change });
    const v = await s.get("/surface");
    assert.strictEqual(v.verdict, verdict, JSON.stringify(change));
    assert.match(v.reasons[0], reason, JSON.stringify(change));
  }
  // worst reading wins, and the milder problem is still listed
  await scout({ ...SAFE, radiation_usv_h: 40, o2_pct: 18 });
  let v = await s.get("/surface");
  assert.strictEqual(v.verdict, "stay underground");
  assert.match(v.reasons[0], /^radiation 40/);
  assert.match(v.reasons[1], /^also: oxygen 18 % is below 19\.5 %/);
  await scout({ ...SAFE, radiation_usv_h: 2, co2_ppm: 6000 });
  v = await s.get("/surface");
  assert.strictEqual(v.verdict, "sealed outposts needed", "outposts (land unfit) outrank domes (air unfit)");
  assert.match(v.reasons[1], /^also: CO2 6000 ppm/);
  // every limit says which option it leads to
  const rad = v.readings.find((r) => r.reading === "radiation_usv_h");
  assert.deepStrictEqual(rad.limits.map((l) => [l.key, l.option]), [["surface_radiation_stay_usv_h", "stay underground"], ["surface_radiation_domes_usv_h", "sealed outposts needed"]]);
  await scout(SAFE);
  assert.strictEqual((await s.get("/surface")).verdict, "suits OK", "the verdict follows the latest readings back down");
});

test("the verdict says whether it rests on live hardware or simulated data", async () => {
  await scout({ radiation_usv_h: 0.3 }, "live");
  let v = await s.get("/surface");
  assert.strictEqual(v.source, "mixed");
  assert.strictEqual(v.readings.find((r) => r.reading === "radiation_usv_h").source, "live");
  await scout(SAFE, "live");
  v = await s.get("/surface");
  assert.strictEqual(v.source, "live");
});

test("/surface/history: append-only public record of every surface reading and every verdict change", async () => {
  const h = await s.get("/surface/history");
  const surfaceReadings = (await s.get("/history?kind=surface")).length;
  assert.strictEqual(h.filter((e) => e.type === "reading").length, surfaceReadings, "every surface reading is on the record");
  assert.deepStrictEqual(h.map((e) => e.seq), h.map((e) => e.seq).slice().sort((a, b) => a - b), "in the order it was stored");
  const verdicts = h.filter((e) => e.type === "verdict");
  assert.deepStrictEqual(verdicts.slice(0, 2).map((e) => [e.previous, e.verdict]), [[null, "not enough data"], ["not enough data", "stay underground"]]);
  for (let i = 1; i < verdicts.length; i++) {
    assert.strictEqual(verdicts[i].previous, verdicts[i - 1].verdict, "each entry links to the one before: no silent change");
    assert.notStrictEqual(verdicts[i].verdict, verdicts[i].previous, "only real changes are recorded");
    assert.ok(verdicts[i].reasons.length >= 1 && verdicts[i].cause, "with its reasons and the reading that caused it");
  }
  for (const v of ["stay underground", "sealed outposts needed", "sealed domes needed"]) assert.ok(verdicts.some((e) => e.verdict === v), v);
  // verdict changes also go out on the feed as alerts, with the limit that was crossed
  const alert = (await s.get("/history?kind=alert")).find((a) => a.values.surface_verdict === "stay underground");
  assert.strictEqual(alert.values.level, "danger");
  assert.match(alert.values.limit.source, /IAEA|National Weather Service|NIOSH/);
  // nothing can be removed or rewritten: after a restart the record is identical, and it only grows
  await s.restart();
  assert.deepStrictEqual(await s.get("/surface/history"), h);
  await scout({ ...SAFE, pm25_ugm3: 400 });
  const h2 = await s.get("/surface/history");
  assert.deepStrictEqual(h2.slice(0, h.length), h, "old entries are untouched");
  assert.deepStrictEqual(h2.slice(h.length).map((e) => e.type), ["reading", "verdict"]);
  assert.strictEqual(h2[h2.length - 1].previous, "suits OK", "the verdict in force survived the restart");
});

test("/firstwave: volunteers only, healthy, no open help request, never sole caregivers, needed skills first", async () => {
  const b = "l3-ember-yard", now = Date.now();
  const vit = (d, values, time = now) => s.post("/ingest", s.R(d, b, "vitals", values, time));
  const press = (d, type, time = now) => s.post("/ingest", s.R(d, b, "button", { button: type }, time));
  const OK = { hr_bpm: 70, spo2_pct: 98, temp_c: 36.7 };
  // register (shared/people.json): 51 medic | 52 engineer+farmer | 53 farmer, sole caregiver | 54 engineer | 55 teacher
  //                                56 medic+engineer | 57 farmer | 58 cook | 60 engineer
  await vit("watch-0051", OK); await press("watch-0051", "volunteer", now - 50e3);
  await vit("watch-0052", OK); await press("watch-0052", "volunteer", now - 40e3);
  await vit("watch-0053", OK); await press("watch-0053", "volunteer", now - 90e3);          // sole caregiver
  await vit("watch-0054", { hr_bpm: 118, spo2_pct: 93, temp_c: 38.6 }); await press("watch-0054", "volunteer", now - 80e3); // unwell
  await vit("watch-0055", OK); await press("watch-0055", "volunteer", now - 70e3);          // healthy, no needed skill
  await vit("watch-0056", OK);                                                            // healthy, best skills, did NOT volunteer
  await press("watch-0057", "volunteer", now - 60e3);                                     // no vitals at all
  await vit("watch-0058", OK); await press("watch-0058", "volunteer", now - 30e3); await press("watch-0058", "help"); // needs help
  await vit("watch-0060", OK, now - 30 * 3600e3); await press("watch-0060", "volunteer", now - 20e3); // vitals 30 h old
  await vit("watch-0099", OK); await press("watch-0099", "volunteer", now - 10e3);          // not in the register

  const f = await s.get("/firstwave");
  assert.strictEqual(f.n, 20);
  assert.strictEqual(f.volunteers, 9);
  assert.deepStrictEqual(f.ranked.map((p) => p.device), ["watch-0052", "watch-0051", "watch-0055"], "two needed skills, then one, then none");
  assert.deepStrictEqual(f.ranked.map((p) => p.rank), [1, 2, 3]);
  assert.deepStrictEqual(f.ranked.map((p) => p.score), [20, 10, 0]);
  assert.ok(!f.ranked.some((p) => p.device === "watch-0056"), "never someone who did not volunteer");
  const top = f.ranked[0];
  assert.strictEqual(top.name, "Tobin Okafor");
  assert.match(top.reasons.join(" | "), /volunteered at .*not a sole caregiver.*no open help request.*latest vitals healthy: SpO2 98 %, pulse 70 bpm, temperature 36\.7 C \(Royal College of Physicians.*\+10: skill "engineer" is needed.*\+10: skill "farmer" is needed/);
  assert.match(f.ranked[2].reasons.join(" | "), /\+0: none of the needed skills \(medic, engineer, farmer\)/);
  const why = Object.fromEntries(f.excluded.map((p) => [p.device, p.reasons.join(" | ")]));
  assert.deepStrictEqual(Object.keys(why).sort(), ["watch-0053", "watch-0054", "watch-0057", "watch-0058", "watch-0060", "watch-0099"]);
  assert.match(why["watch-0053"], /sole caregiver: never sent up/);
  assert.match(why["watch-0054"], /SpO2 93 % is below 96 %.*pulse 118 bpm is above 90 bpm.*temperature 38\.6 C is above 38 C/);
  assert.match(why["watch-0057"], /not enough data: no vitals on record/);
  assert.match(why["watch-0058"], /has an open help request/);
  assert.match(why["watch-0060"], /latest vitals are older than 24 h/);
  assert.match(why["watch-0099"], /not in the people register/);

  // ?n= cuts the list; a bad n is refused
  assert.deepStrictEqual((await s.get("/firstwave?n=2")).ranked.map((p) => p.device), ["watch-0052", "watch-0051"]);
  assert.strictEqual((await s.getRaw("/firstwave?n=0")).status, 400);
  assert.strictEqual((await s.getRaw("/firstwave?n=abc")).status, 400);

  // once the help request is answered and fresh vitals arrive, people become eligible
  await s.post("/dispatch", { responder: "rover-01", block: b });
  await vit("watch-0060", OK);
  const f2 = await s.get("/firstwave");
  assert.deepStrictEqual(f2.ranked.map((p) => p.device), ["watch-0052", "watch-0051", "watch-0060", "watch-0055", "watch-0058"]);
  // a volunteer whose latest vitals turn bad drops out
  await vit("watch-0052", { hr_bpm: 70, spo2_pct: 91, temp_c: 36.7 }, now + 1000);
  assert.ok(!(await s.get("/firstwave")).ranked.some((p) => p.device === "watch-0052"));
});

test("/firstwave is tied to the surface verdict: ranked always, cleared only when people may go up", async () => {
  await scout(SAFE);
  let f = await s.get("/firstwave");
  assert.deepStrictEqual([f.surface_verdict, f.cleared], ["suits OK", true]);
  await scout({ ...SAFE, radiation_usv_h: 60 });
  f = await s.get("/firstwave");
  assert.deepStrictEqual([f.surface_verdict, f.cleared], ["stay underground", false]);
  assert.match(f.note, /nobody goes up yet/);
  assert.ok(f.ranked.length >= 1, "the order is still shown");
});
