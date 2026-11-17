// Hollow Twin API (lane 1). No dependencies: `npm start` in the api folder, or `node api/server.js` from the repository root.
// It speaks CONTRACT.md (one level up): the message format, the 70 blocks of contract/blocks.json, and these endpoints.
//
// The contract's endpoints (CONTRACT.md section 4):
// POST /ingest            one message or an array (relay backlogs). Duplicates by id are dropped.
//                         Replies { accepted, duplicates, rejected: [{ id, problems }], warnings: [{ id, warnings }] }.
//                         Limits: 5 MB body, 20 single posts per device per second (an array is one request, never dropped),
//                         a time before 2020, or any time ahead of the receive time, is replaced by the receive time
//                         (time_estimated, device_time). "Latest" = greatest stored time, ties broken by seq (order.js).
//                         An unknown block is rejected; a device id that does not fit section 3 is a warning.
//                         The old value names (hr, spo2, button type) are accepted as aliases and renamed.
//                         If the INGEST_KEY env var is set, every POST needs the header x-api-key.
//                         Optional "sig" (HMAC-SHA256, see sign.js): valid = stored verified:true, wrong = rejected
//                         and made public as a forgery (GET /forgeries, event: forgery), none = stored verified:false.
// GET  /live              server-sent events: `event: reading` per accepted message, `event: alert` per alert. Each event
//                         has an id (the record's seq); reconnect with the Last-Event-ID header or ?lastEventId= to get
//                         everything missed, in order. `event: forgery` (no id) for each refused forged message.
// GET  /blocks/<id>/latest  the latest message of each kind for one block
// GET  /help              open help requests, highest priority first (?status=assigned|all, &to=rover-01)
// POST /help/<id>/assign  { to: "rover-01" }  marks a help request as assigned and tells the resident
// POST /help/<id>/delivered { by: "rover-01", note: "med kit" }  the responder arrived: closes it and tells the resident
// GET  /broadcast         for the public page: latest surface readings against their limits, the verdict text, the
//                         newest photo, and a link to the history
//
// Everything else:
// GET  /feed              the same stream as /live with unnamed events (the name used before the contract)
// GET  /history           ?block=&kind=&since=&after_seq=  stored messages in time order (replays a network gap)
// GET  /blocks            latest message per block and kind, for every block
// GET  /forecast          ?block=  battery hours left = battery_wh / (draw_w - supply_w), + grid frequency stress
// GET  /fairshare         ?supply_w= or ?supply_pct=  &policy=directorate|fair   who gets power, all 70 blocks (one per-person
//                         model), plus `measured`: what each block's real relay reports, kept apart
// GET  /queue             the same list as /help (its earlier name)
// POST /dispatch          {responder, block}  sends the responder to the top request
// POST /family            {group, devices:[...]}  links watches into a family group
// GET  /family            ?family= (or ?group=)  who in the group has checked in, from where, by what route
// GET  /inbox             ?device=&after_seq=  alerts addressed to this watch (relays fetch these for watches)
// POST /official          {block, count}  the Directorate's published case count
// GET  /truth             residents' count vs official count, per block
// GET  /surface           latest surface readings vs their limits, and the verdict: suits OK / sealed domes needed /
//                         sealed outposts needed / stay underground / not enough data, with the exact reasons
// GET  /surface/history   append-only public record: every surface reading and every verdict change
// GET  /firstwave         ?n=20  who goes up first: healthy volunteers, never sole caregivers, needed skills first
// GET  /status            everything the twin needs in one poll: forecast per block, alerts in the last hour, help queue,
//                         truth totals, surface verdict, live vs simulated per block, verified vs unverified counts
// GET  /limits            every threshold in use, with its published source (shared/limits.json)
// GET  /forgeries         ?after=<n>  the public log of forged readings (wrong sig): refused, never stored as readings;
//                         each one also goes out on /live as `event: forgery`
const http = require("http");
const fs = require("fs");
const path = require("path");
const B = require("./blocks");
const C = require("./contract");
const HEAT = require("./heat");
const L = require("./logic");
const LIM = require("./limits");
const O = require("./order");
const SENS = require("./sensors");
const SIGN = require("./sign");
const SURF = require("./surface");

const PORT = process.env.PORT || 8787;
const DATA = process.env.DATA || path.join(__dirname, "readings.jsonl");
const INGEST_KEY = process.env.INGEST_KEY || "";       // when set, every POST needs header x-api-key
const RATE_LIMIT = Number(process.env.RATE_LIMIT) || LIM.val("ingest_rate_limit_per_s");
const MAX_BODY = LIM.val("ingest_max_body_bytes");
const MIN_TIME = Date.parse(LIM.val("ingest_min_valid_time"));
const WARN_AHEAD_MS = LIM.val("ingest_clock_warn_ahead_ms");  // replaced when ahead at all; warned only past clock jitter
const KEYS = SIGN.loadKeys();                          // device -> secret, for checking signed readings
// Who people are: skills and whether someone depends on them alone. Used only by /firstwave.
const PEOPLE = JSON.parse(fs.readFileSync(process.env.PEOPLE || path.join(__dirname, "shared/people.json"), "utf8"));

const readings = [];   // everything stored, in order: what /history, /live and the public records serve
const usable = [];     // the same minus sensor errors (plausible: false): what every forecast, verdict, queue and count uses
const sensorIndex = SENS.index(); // device messages by device and kind, and by kind and level, for the bad-sensor checks
const seen = new Set();
const clients = new Map();  // open event streams -> true when the client asked for /live (named events), false for /feed
const assigned = new Map(); // help request (message id) -> { to, time }: who was sent, and when
const families = {};   // group -> [devices]
const official = {};   // block -> count
const forecastTold = new Map(); // block -> the worst battery level its residents have been told about (1 = warn, 2 = alarm)
const learned = {};             // family group -> Set of watches that have checked in naming it
let surfaceVerdict = null; // the last verdict written to the public record
let lastSeq = 0;       // every stored record gets the next number; it is the SSE event id and is saved with the record
// Forged readings (CONTRACT.md section 4.1): a message whose sig is wrong for a device we hold a key for is refused,
// and the refusal is made public (GET /forgeries, `event: forgery` on /live) so the twin can show "FORGED: rejected".
// A forgery is never a reading: it is not in `readings`, has no seq, and its id is not marked seen (so a forger
// cannot burn the id of a real message that has not arrived yet).
const forgeries = [];  // the public log, oldest first: the newest forgery_log_max entries (the data file keeps them all)
let forgeryCount = 0;  // every forgery ever logged; each entry's `n`
let forgeryLimited = 0; // forgeries refused but not logged because of the rate limit, since this server started
const forgeryRate = new Map(); // claimed device -> { start, count } for the current one-second window

function load() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true }); // e.g. DATA=/home/data/readings.jsonl on a fresh host
  if (!fs.existsSync(DATA)) return;
  const text = fs.readFileSync(DATA, "utf8");
  // a crash can leave half a line at the end: close it so the next append starts on a fresh line
  if (text.length && !text.endsWith("\n")) fs.appendFileSync(DATA, "\n");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { console.error("skipping a damaged line in the data file"); continue; }
    if (!r || typeof r !== "object") continue;
    if (r._meta) { applyMeta(r._meta); continue; }
    if (r._forgery) { remember(r._forgery); continue; } // the public forgery log, never a reading
    if (!r.source) r.source = "simulated"; // lines written before the field existed
    if (r.verified === undefined && r.kind !== "alert") r.verified = false;
    // lines written before the contract: rename their values so everything served uses contract names
    if (r.kind !== "alert" && r.values && typeof r.values === "object") r.values = C.normalise(r.kind, r.values).values;
    r.seq = lastSeq = Math.max(lastSeq + 1, r.seq || 0); // older files have no seq: number them in file order
    readings.push(r); if (r.plausible !== false) usable.push(r); sensorIndex.add(r); seen.add(r.id); learn(r);
    if (r.kind === "alert" && r.values && r.values.surface_verdict) surfaceVerdict = r.values.surface_verdict;
  }
}
function applyMeta(m) {
  if (m.dispatched) assigned.set(m.dispatched, { to: null, time: null }); // written before /help/<id>/assign existed
  if (m.assigned) assigned.set(m.assigned.id, { ...(assigned.get(m.assigned.id) || {}), to: m.assigned.to, time: m.assigned.time });
  if (m.delivered) { const a = assigned.get(m.delivered.id) || { to: m.delivered.by, time: m.delivered.time };
    assigned.set(m.delivered.id, { ...a, delivered_by: m.delivered.by, delivered_at: m.delivered.time, note: m.delivered.note || null }); }
  if (m.family) families[m.family.group] = m.family.devices;
  if (m.official) official[m.official.block] = m.official.count;
}
function saveMeta(m) { applyMeta(m); fs.appendFileSync(DATA, JSON.stringify({ _meta: m }) + "\n"); }

// A family group is the watches registered for it (POST /family) plus every watch that has itself checked in
// naming that group. So two relatives who both press "I'm OK" for fam-0007 find each other with no setup step.
function learn(r) {
  const family = r.values && typeof r.values.family === "string" && r.values.family;
  if (family && (r.kind === "checkin" || r.kind === "button")) (learned[family] ||= new Set()).add(r.device);
}
const familyOf = (group) => [...new Set([...(families[group] || []), ...(learned[group] || [])])];
// the newest "I'm OK" from a watch, whichever way it was sent
const isOk = (r) => (r.kind === "checkin" && (r.values.status === undefined || r.values.status === "ok")) || (r.kind === "button" && r.values.button === "ok");

// Turns what a device sent into the record we store ({ rec }), or the reasons for refusing it ({ id, problems }).
// The record uses contract names only: legacy value names are renamed here, on the way in.
function accept(r, now) {
  const bad = C.problems(r);
  if (r && typeof r.block === "string" && r.block && B.problem(r.block)) bad.push(B.problem(r.block)); // only blocks in contract/blocks.json, or "surface"
  if (bad.length) return { id: (r && typeof r === "object" && r.id) ?? null, problems: bad };
  // Signature: checked against exactly what the device sent (its own time string and value names), before we touch anything.
  let verified = false, sigUnchecked;
  if (r.sig !== undefined) {
    const key = KEYS[r.device];
    if (key) {
      if (!SIGN.check(r, key)) {
        const reason = `bad signature for ${r.device}: sig does not match id|device|block|time|kind|values`;
        return { id: r.id, problems: [reason], forgery: forged(r, reason, now) };
      }
      verified = true;
    } else sigUnchecked = `no key on file for ${r.device}`; // cannot check it, so it is stored as unverified
  }
  const { values, renamed } = C.normalise(r.kind, r.values);
  const wrong = C.valueProblems(r.kind, values);
  if (wrong.length) return { id: r.id, problems: wrong };
  const route = C.route(r);
  // a device id that does not fit CONTRACT.md section 3 is noted on the record, never a reason to refuse it
  const warnings = [...route.warnings, ...B.deviceWarnings(r), ...B.messageWarnings({ ...r, values })];
  if (renamed.length) warnings.push(`old field names renamed to contract names: ${renamed.join(", ")}`);
  const rec = { ...r, values, hops: route.hops, via: route.via, source: r.source || "simulated" }; // honest default: only real hardware says "live"
  for (const f of ["seq", "time_estimated", "device_time", "verified", "sig_unchecked", "warnings", "plausible", "sensor_error", "sensor_flags"]) delete rec[f]; // these are ours to set, never the sender's
  rec.verified = verified;
  if (sigUnchecked) rec.sig_unchecked = sigUnchecked;
  // A time we cannot trust never reaches the timeline: the reading is kept, stamped with the receive time and marked.
  //   before 2020 = an ESP32 that has not synced its clock yet (it reports 1970)
  //   ahead of the moment we received it = a clock running fast, a wrong time zone, or a fixed sample time. Nothing can
  //   be measured after it arrives, so any time ahead is replaced: otherwise a fast clock would hold "latest" for its
  //   block and kind over every honest reading until real time caught up with it.
  const taken = Date.parse(r.time), early = taken < MIN_TIME, late = taken > now;
  if (early || late) {
    rec.device_time = r.time;
    rec.time = new Date(now).toISOString();
    rec.time_estimated = true;
    if (early || taken - now > WARN_AHEAD_MS) warnings.push(early
      ? `time ${r.time} is before ${LIM.val("ingest_min_valid_time").slice(0, 4)} (device clock not set): stored with the receive time`
      : `time ${r.time} is ahead of the server's receive time ${new Date(now).toISOString()} (device clock fast): stored with the receive time, the device's time kept as device_time`);
  }
  if (warnings.length) rec.warnings = warnings;
  return { rec };
}

// The public record of one forged message: who it claimed to be, where, what it claimed, and why it was refused.
// What a forger claims is capped (forgery_max_values_bytes) so the log cannot be used to push large payloads.
function forged(r, reason, now) {
  const route = C.route(r);
  const claimed = { id: r.id, claimed_time: r.time, claimed_values: r.values, hops: route.hops, via: route.via };
  const bytes = Buffer.byteLength(JSON.stringify(claimed));
  const shown = bytes <= LIM.val("forgery_max_values_bytes") ? claimed
    : { id: r.id.slice(0, 100), claimed_time: r.time.slice(0, 40), claimed_values: null, hops: route.hops, via: [], claimed_bytes: bytes };
  return { time: new Date(now).toISOString(), device: r.device, block: r.block, kind: r.kind, ...shown, reason, rejected: true };
}
function remember(f) {
  forgeries.push(f);
  forgeryCount = Math.max(forgeryCount, f.n || 0);
  if (forgeries.length > LIM.val("forgery_log_max")) forgeries.splice(0, forgeries.length - LIM.val("forgery_log_max"));
}
// Logs a forgery and sends it to /live, at most RATE_LIMIT per claimed device per second (the ingest limit). Unlike
// ingest, every forged message counts, also inside an array: a real backlog must never be dropped, but a forgery is
// not data, and one array of thousands must not flood every screen showing the twin.
function publishForgery(f, now) {
  let w = forgeryRate.get(f.device);
  if (!w || now - w.start >= 1000) forgeryRate.set(f.device, (w = { start: now, count: 0 }));
  if (++w.count > RATE_LIMIT) { forgeryLimited++; return; }
  f.n = forgeryCount + 1;
  remember(f);
  fs.appendFileSync(DATA, JSON.stringify({ _forgery: f }) + "\n");
  // only /live (named events): /feed's unnamed events are all readings and alerts, and old clients treat them so.
  // No `id:` line, so a client's Last-Event-ID stays the seq of the last real record.
  for (const [c, named] of clients) if (named) c.write(`event: forgery\ndata: ${JSON.stringify(f)}\n\n`);
}

// Bad-sensor checks (sensors.js), before a device message is stored, against what is stored so far: an impossible
// value, a jump or a drift makes it a sensor error. It is still stored (and shown on /history and /live) with
// plausible: false and the reason, the sender is told in the reply's warnings, and nothing else ever uses it.
function inspect(r) {
  const flags = SENS.check(r, sensorIndex);
  if (!flags.length) return;
  r.plausible = false;
  r.sensor_error = flags.map((f) => f.reason).join("; ");
  r.sensor_flags = flags;
  r.warnings = [...(r.warnings || []), `sensor error, stored but not used: ${r.sensor_error}`];
}

function alert(r, level, text, extra = {}, suffix = "0") {
  // an alert is as real as the reading that caused it: it inherits live/simulated
  return { id: `alert-${r.id}-${suffix}`, device: "backend", block: r.block,
    time: new Date().toISOString(), kind: "alert", values: { level, text, cause: r.id, cause_verified: r.verified === true, ...extra },
    hops: 0, via: [], source: r.source || "simulated" };
}

// Every rule compares a reading with a limit from shared/limits.json and says why it fired:
// alert.values.why is one sentence, .limit is the limit crossed (value, unit, source, url), .limits is all of them.
function rules(r) {
  const v = r.values, out = [];
  if (r.kind === "power") {
    if (typeof v.grid_hz === "number" && L.gridOff(v.grid_hz))
      out.push(alert(r, "danger", `Grid frequency ${v.grid_hz} Hz: power cut likely soon in ${r.block}`,
        { why: L.gridWhy(v.grid_hz), limit: LIM.ref("grid_band_hz"), limits: [LIM.ref("grid_band_hz"), LIM.ref("grid_nominal_hz")] }, "grid"));
    // Battery: one warning (CONTRACT.md section 6: under 24 h) and one alarm (under 8 h, or dark) per slide down.
    const f = L.forecast(usable, r.block), now = f.level === "alarm" ? 2 : f.level === "warn" ? 1 : 0, told = forecastTold.get(r.block) || 0;
    if (now > told) {
      forecastTold.set(r.block, now);
      const key = now === 2 ? "battery_alarm_hours" : "battery_warn_hours";
      const whole = Math.round(f.hours_left), left = whole ? `about ${whole} h` : "less than 1 h";
      out.push(alert(r, now === 2 ? "danger" : "warn",
        f.dark ? `${r.block} is dark: its battery is empty` : `${r.block} has ${left} of battery left`,
        { hours_left: f.hours_left, forecast_level: f.level, method: f.method, dark: f.dark,
          ...(f.dark ? { why: f.reasons[f.reasons.length - 1], limit: LIM.ref(key), limits: [LIM.ref(key)] } : LIM.because(LIM.hits([[key, f.hours_left, "battery forecast"]]))) }, "fc"));
    } else if (now < told && f.method && !f.dark) {
      // Re-arm a level only once the forecast is clearly back above it (or the battery stopped draining),
      // so a forecast hovering at a line does not buzz every watch on every reading.
      const margin = LIM.val("battery_rearm_margin_hours");
      const clear = (key) => f.hours_left === null || f.hours_left >= LIM.val(key) + margin;
      forecastTold.set(r.block, Math.max(now, clear("battery_warn_hours") ? 0 : clear("battery_alarm_hours") ? 1 : told));
    }
  }
  if (r.kind === "water") {
    const h = LIM.hits([["water_tds_max_ppm", v.tds_ppm, "TDS"], ["water_turbidity_max_ntu", v.turbidity_ntu, "turbidity"]]);
    if (h.length) out.push(alert(r, "danger", `Do not drink: tap water failing in ${r.block}`, LIM.because(h)));
  }
  if (r.kind === "air") {
    const bad = LIM.hits([["air_co2_danger_ppm", v.co2_ppm, "CO2"]]), stale = LIM.hits([["air_co2_stale_ppm", v.co2_ppm, "CO2"]]);
    if (bad.length) out.push(alert(r, "danger", `Air unsafe in ${r.block}: CO2 ${v.co2_ppm} ppm`, LIM.because(bad)));
    else if (stale.length) out.push(alert(r, "warn", `Air going stale in ${r.block}: CO2 ${v.co2_ppm} ppm`, LIM.because(stale)));
    // Heat: the contract's air message carries temp_c and humidity_pct, so the US National Weather Service heat index
    // (how hot it feels) can be compared with the NWS danger levels. Without humidity the air temperature is used.
    const heat = HEAT.feelsLike(v.temp_c, v.humidity_pct);
    if (heat) {
      const extreme = LIM.hits([["air_heat_danger_c", heat.c, heat.label]]), danger = LIM.hits([["air_heat_warn_c", heat.c, heat.label]]);
      const hit = extreme.length ? extreme : danger;
      if (hit.length) {
        const why = LIM.because(hit);
        out.push(alert(r, extreme.length ? "danger" : "warn", `${extreme.length ? "Extreme heat" : "Dangerous heat"} in ${r.block}: feels like ${Math.round(heat.c)} C`,
          { ...why, why: `${why.why}; ${heat.detail}`, feels_like_c: heat.c }, "heat"));
      }
    }
  }
  if (r.kind === "flood") {
    const h = LIM.hits([["flood_depth_closed_cm", v.depth_cm, "flood depth"]]);
    if (h.length) out.push(alert(r, "warn", `Flooding in ${r.block}: tunnel closed`, LIM.because(h)));
  }
  if (r.kind === "surface") {
    // every verdict change goes on the record (and out on the feed) with the reading that caused it
    const sv = SURF.surface(usable);
    if (sv.verdict !== surfaceVerdict) {
      const level = sv.verdict === SURF.STAY || sv.verdict === SURF.OUTPOSTS ? "danger" : sv.verdict === SURF.DOMES ? "warn" : "info";
      const crossed = sv.readings.filter((x) => x.status === sv.verdict).flatMap((x) => x.limits.filter((l) => LIM.crossed(l.key, x.value)));
      out.push(alert(r, level, `Surface verdict: ${sv.verdict}`, { surface_verdict: sv.verdict, previous: surfaceVerdict,
        reasons: sv.reasons, why: sv.reasons.join("; "), ...(crossed.length ? { limit: crossed[0], limits: crossed } : {}) }, "surface"));
      surfaceVerdict = sv.verdict;
    }
  }
  if (r.kind === "button" && v.button === "volunteer")
    out.push(alert(r, "info", `${r.device} volunteered for the first wave`, { to: [r.device], why: `${r.device} pressed the volunteer button` }, "vol"));
  if (r.kind === "tunnel" && v.status === "closed") {
    // a tunnel joins two blocks: residents of both are told (see /inbox), with the rover's reason and photo
    const ends = [v.from_block, v.to_block].filter((b) => typeof b === "string" && b);
    const where = ends.length === 2 ? `between ${ends[0]} and ${ends[1]}` : `in ${r.block}`;
    const reason = typeof v.reason === "string" && v.reason ? v.reason : null;
    out.push(alert(r, "warn", `Tunnel closed ${where}${reason ? ` (${reason})` : ""}: use another route`,
      { why: `${r.device} reported the tunnel ${where} closed${reason ? `: ${reason}` : ""}`, blocks: [...new Set([r.block, ...ends])],
        ...(ends.length === 2 ? { from_block: ends[0], to_block: ends[1] } : {}), ...(reason ? { reason } : {}),
        ...(v.photo_url ? { photo_url: v.photo_url } : {}) }));
  }
  if (r.kind === "button" && v.button === "help")
    out.push(alert(r, "danger", `Help requested by ${r.device} in ${r.block}`, { why: `${r.device} pressed the help button` }));
  // "I'm OK": a contract `checkin` (or, before the contract, an ok button press naming a family group).
  // It goes to the watches listed in `to` and to everyone in its family group, never to strangers.
  if (r.kind === "checkin" || (r.kind === "button" && v.button === "ok" && v.family)) {
    const family = typeof v.family === "string" && v.family ? v.family : null;
    const direct = Array.isArray(v.to) ? v.to : [];
    const to = [...new Set([...direct, ...(family ? familyOf(family) : [])])].filter((d) => d !== r.device);
    const ok = r.kind === "button" || v.status === undefined || v.status === "ok";
    const relayed = r.hops > 0 ? `, relayed over ${r.hops} hop${r.hops === 1 ? "" : "s"} (${r.via.join(" > ")})` : "";
    if (to.length) out.push(alert(r, "info", ok ? `${r.device} is OK (${r.block})` : `${r.device} checked in: ${v.status} (${r.block})`,
      { to, ...(family ? { family } : {}), status: ok ? "ok" : v.status, sent: r.time, hops: r.hops, via: r.via,
        why: `${r.device} checked in${family ? ` for family group ${family}` : ""}${direct.length ? `, to ${direct.join(", ")}` : ""}${relayed}` }));
  }
  return out;
}

// Per block: is its newest device reading live hardware or simulated? (alerts are ignored: they only echo their cause)
function blockSources() {
  const out = {};
  for (const r of usable) {
    if (r.kind === "alert") continue;
    const b = (out[r.block] ||= { latest: null, source: r.source, latest_time: r.time, latest_device: r.device, live_kinds: new Set(), simulated_kinds: new Set() });
    if (O.newer(r, b.latest)) { b.latest = r; b.source = r.source; b.latest_time = r.time; b.latest_device = r.device; }
  }
  // a kind is live when that kind's newest reading in the block is live
  const newest = {};
  for (const r of usable) {
    if (r.kind === "alert") continue;
    const k = `${r.block}|${r.kind}`;
    if (O.newer(r, newest[k])) newest[k] = r;
  }
  for (const r of Object.values(newest)) out[r.block][`${r.source}_kinds`].add(r.kind);
  for (const b of Object.values(out)) { delete b.latest; b.live_kinds = [...b.live_kinds].sort(); b.simulated_kinds = [...b.simulated_kinds].sort(); }
  return out;
}

// One server-sent event. GET /live (CONTRACT.md section 4) names its events: "reading" for a device message, "alert" for
// one of ours. GET /feed is the older stream and sends the same data unnamed, so EventSource.onmessage keeps working.
const sse = (r, named) => `id: ${r.seq}\n${named ? `event: ${r.kind === "alert" ? "alert" : "reading"}\n` : ""}data: ${JSON.stringify(r)}\n\n`;

function store(r) {
  if (seen.has(r.id)) return false;
  seen.add(r.id);
  r.seq = ++lastSeq;
  readings.push(r); if (r.plausible !== false) usable.push(r); sensorIndex.add(r); learn(r);
  fs.appendFileSync(DATA, JSON.stringify(r) + "\n");
  for (const [c, named] of clients) c.write(sse(r, named));
  return true;
}

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}
// Reads a JSON body. Answers 401 (wrong key) and 413 (too large) itself; bad JSON goes to cb("body is not JSON").
function readBody(req, res, cb) {
  const chunks = []; let size = 0, tooBig = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) { tooBig = true; chunks.length = 0; if (size > LIM.val("ingest_drain_factor") * MAX_BODY) req.destroy(); return; } // keep draining, keep nothing
    chunks.push(c);
  });
  req.on("error", () => {});
  req.on("end", () => {
    if (INGEST_KEY && req.headers["x-api-key"] !== INGEST_KEY) return send(res, 401, { error: "missing or wrong x-api-key header" });
    if (tooBig) return send(res, 413, { error: `body too large: the limit is ${MAX_BODY} bytes. Split the backlog into smaller arrays.`, limit_bytes: MAX_BODY });
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return guard(res, () => cb("body is not JSON")); }
    guard(res, () => cb(null, body));
  });
}
// A bug in one request must never take the server down: answer 500 and keep serving.
function guard(res, fn) {
  try { fn(); } catch (e) {
    console.error("request failed:", e);
    if (!res.headersSent) send(res, 500, { error: "internal error" }); else res.end();
  }
}

// Per-device rate limit for single posts. A relay backlog sent as ONE array is one request and is never dropped.
const rate = new Map(); // device -> { start, count } for the current one-second window
function overLimit(req, body, now) {
  const first = Array.isArray(body) ? body[0] : body;
  const device = req.headers["x-device"] || (first && typeof first.device === "string" ? first.device : null);
  if (!device) return null;
  if (rate.size > LIM.val("ingest_rate_table_max")) rate.clear();
  let w = rate.get(device);
  if (!w || now - w.start >= 1000) rate.set(device, (w = { start: now, count: 0 }));
  w.count++;
  return !Array.isArray(body) && w.count > RATE_LIMIT ? device : null;
}

// Marks a help request as assigned, remembers it across restarts, and tells the resident who is coming.
function assign(item, to) {
  const time = new Date().toISOString();
  saveMeta({ assigned: { id: item.id, to, time } });
  store(alert(readings.find((r) => r.id === item.id) || { id: item.id, block: item.block }, "info", `${to} sent to ${item.device} in ${item.block}`,
    { to: [item.device], responder: to, why: `${to} was assigned to the help request ${item.id}` }, "dispatch"));
  return { ...item, status: "assigned", assigned_to: to, assigned_at: time };
}

// The responder arrived: closes the request, remembers it across restarts, and tells the resident what was brought.
function delivered(item, by, note) {
  const time = new Date().toISOString();
  saveMeta({ delivered: { id: item.id, by, time, note } });
  store(alert(readings.find((r) => r.id === item.id) || { id: item.id, block: item.block }, "info",
    `${by} reached ${item.device} in ${item.block}${note ? `: ${note}` : ""}`,
    { to: [item.device], responder: by, why: `${by} arrived for the help request ${item.id}${note ? ` with ${note}` : ""}` }, "delivered"));
  return { ...item, status: "delivered", assigned_to: item.assigned_to || by, delivered_by: by, delivered_at: time, note: note || null };
}

load();
const server = http.createServer((req, res) => guard(res, () => route(req, res)));
function route(req, res) {
  let url;
  try { url = new URL(req.url, "http://x"); } catch { return send(res, 400, { error: "bad url" }); }
  const q = Object.fromEntries(url.searchParams);
  const p = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID, x-api-key, x-device",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
    return res.end();
  }
  if (req.method === "POST" && p === "/ingest") return readBody(req, res, (e, body) => {
    if (e) return send(res, 400, { error: e });
    const now = Date.now(), limited = overLimit(req, body, now);
    if (limited) {
      res.setHeader("Retry-After", "1");
      return send(res, 429, { error: `rate limit: more than ${RATE_LIMIT} requests per second from ${limited}. Wait a second, or send the readings as one array.`, retry_after_s: 1 });
    }
    // The reply is CONTRACT.md section 4, in the same shape as tools/catcher.mjs: { accepted, duplicates, rejected }.
    // `warnings` is ours: messages that were stored, with something the sender should fix.
    let accepted = 0, duplicates = 0; const rejected = [], warnings = [];
    // backlogs may arrive out of order: process oldest first so forecasts see true order (and /live replays the gap in order)
    const recs = [];
    for (const r of [].concat(body)) {
      const a = accept(r, now);
      if (a.problems) {
        rejected.push({ id: a.id, problems: a.problems });
        if (a.forgery) publishForgery(a.forgery, now); // still rejected; made public, never stored as a reading
      } else recs.push(a.rec);
    }
    recs.sort((a, b) => Date.parse(a.time) - Date.parse(b.time)); // stable: equal times keep the order they were sent in
    for (const r of recs) {
      if (seen.has(r.id)) { duplicates++; continue; }
      inspect(r);           // impossible values, jumps and drift, against what is stored so far
      store(r); accepted++;
      if (r.warnings) warnings.push({ id: r.id, warnings: r.warnings });
      if (r.plausible === false) continue; // a sensor error raises nothing and feeds nothing
      rules(r).forEach(store);
    }
    send(res, rejected.length && !accepted ? 422 : 200, { accepted, duplicates, rejected, warnings });
  });
  if (p === "/live" || p === "/feed") {
    const named = p === "/live";
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no" }); // tells nginx-style proxies (Azure, Render) not to hold events back
    res.write(`: connected\nretry: ${LIM.val("feed_retry_ms")}\n\n`);
    // Reconnect: the browser sends the last id it saw; send everything after it, in order, then go live.
    // This block has no awaits, so no event can slip between the replay and joining the live set.
    const lastRaw = req.headers["last-event-id"] ?? q.lastEventId;
    if (lastRaw !== undefined && lastRaw !== "") {
      let last = Number(lastRaw);
      if (!(last >= 0)) last = 0;
      if (last > lastSeq) { // the client is ahead of us: our data file was reset (e.g. a free-tier disk wipe)
        res.write(`event: reset\ndata: ${JSON.stringify({ seq: lastSeq })}\n\n`);
        last = 0;
      }
      for (const r of readings) if (r.seq > last) res.write(sse(r, named));
    }
    clients.set(res, named);
    const ping = setInterval(() => res.write(": ping\n\n"), LIM.val("feed_ping_s") * 1000); // keeps proxies from closing it
    req.on("close", () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (p === "/history") {
    const since = q.since ? Date.parse(q.since) : 0, afterSeq = Number(q.after_seq) || 0;
    return send(res, 200, readings
      .filter((r) => (!q.block || r.block === q.block) && (!q.kind || r.kind === q.kind) && Date.parse(r.time) >= since && r.seq > afterSeq)
      .sort(O.byTime));
  }
  // CONTRACT.md section 4: the latest message of each kind for one block
  const one = /^\/blocks\/([^/]+)\/latest$/.exec(p);
  if (one) {
    const id = decodeURIComponent(one[1]);
    if (!B.known(id)) return send(res, 404, { error: B.problem(id) });
    const latest = {};
    for (const r of usable)
      if (r.block === id && r.kind !== "alert" && O.newer(r, latest[r.kind])) latest[r.kind] = r;
    const info = B.get(id), src = blockSources()[id];
    return send(res, 200, { block: id, name: info ? info.name : "Surface", level: info ? info.level : null, people: info ? info.people : null,
      source: src ? src.source : null, // is this block's newest message live hardware or simulated? null = nothing yet
      latest });
  }
  if (p === "/blocks") {
    const latest = {};
    for (const r of usable) {
      const k = `${r.block}|${r.kind}`;
      if (O.newer(r, latest[k])) latest[k] = r;
    }
    const src = blockSources();
    return send(res, 200, Object.values(latest).map((r) => ({ ...r, block_source: src[r.block] ? src[r.block].source : r.source })));
  }
  if (p === "/forecast") {
    const blocks = q.block ? [q.block] : [...new Set(usable.filter((r) => r.kind === "power").map((r) => r.block))];
    return send(res, 200, blocks.map((b) => L.forecast(usable, b)));
  }
  if (p === "/fairshare") {
    // The 70-block table is one model: every block sized from its people (megawatts). What real relays measure
    // (watts) is a separate section, `measured`, so an estimate and a reading are never compared in one table.
    const sector = L.sector();
    // the supply, in watts (supply_w) or as a share of what the sector needs (supply_pct)
    const supply = q.supply_pct !== undefined && q.supply_w === undefined
      ? Math.round((sector.reduce((s, b) => s + b.demand_w, 0) * Number(q.supply_pct)) / 100) : Number(q.supply_w);
    if (!(supply >= 0)) return send(res, 400, { error: "supply_w (watts) or supply_pct (percent of sector demand) required" });
    if (q.policy && !["directorate", "fair"].includes(q.policy)) return send(res, 400, { error: "policy must be directorate or fair" });
    const measured = L.measured(usable);
    if (q.policy) return send(res, 200, { ...L.allocate(sector, supply, q.policy), measured });
    return send(res, 200, { directorate: L.allocate(sector, supply, "directorate"), fair: L.allocate(sector, supply, "fair"), measured });
  }
  // CONTRACT.md section 4: GET /help = open help requests, highest priority first. /queue is the same list under its old name.
  // ?status=assigned or ?status=all also shows requests somebody was sent to; &to=rover-01 narrows to one responder.
  if (p === "/help" || p === "/queue") {
    const status = q.status || "open";
    if (!["open", "assigned", "delivered", "all"].includes(status)) return send(res, 400, { error: "status must be open, assigned, delivered or all" });
    return send(res, 200, L.queue(usable, assigned, Date.now(), status).filter((x) => !q.to || x.assigned_to === q.to));
  }
  // CONTRACT.md section 4: POST /help/<message id>/assign with body { "to": "rover-01" }
  const help = /^\/help\/([^/]+)\/assign$/.exec(p);
  if (req.method === "POST" && help) return readBody(req, res, (e, b) => {
    if (e || !b || typeof b !== "object") return send(res, 400, { error: e || "need a JSON object" });
    if (typeof b.to !== "string" || !b.to) return send(res, 400, { error: 'body must be { "to": "<who is sent, for example rover-01>" }' });
    const id = decodeURIComponent(help[1]);
    const item = L.queue(usable, assigned, Date.now(), "all").find((x) => x.id === id);
    if (!item) return send(res, 404, { error: `no help request with message id "${id}" (see GET /help)` });
    if (item.status === "delivered") return send(res, 409, { error: `already delivered by ${item.delivered_by}`, assigned: item });
    if (item.status === "assigned") return send(res, 409, { error: `already assigned${item.assigned_to ? ` to ${item.assigned_to}` : ""}`, assigned: item });
    send(res, 200, { assigned: assign(item, b.to) });
  });
  // POST /help/<message id>/delivered with body { "by": "rover-01", "note": "med kit" }: the responder arrived.
  // Works on an open request too (the responder went without being assigned), never twice.
  const done = /^\/help\/([^/]+)\/delivered$/.exec(p);
  if (req.method === "POST" && done) return readBody(req, res, (e, b) => {
    if (e || !b || typeof b !== "object") return send(res, 400, { error: e || "need a JSON object" });
    if (typeof b.by !== "string" || !b.by) return send(res, 400, { error: 'body must be { "by": "<who arrived, for example rover-01>", "note": "<optional: what they brought>" }' });
    if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 200)) return send(res, 400, { error: "note must be a string of at most 200 characters" });
    const id = decodeURIComponent(done[1]);
    const item = L.queue(usable, assigned, Date.now(), "all").find((x) => x.id === id);
    if (!item) return send(res, 404, { error: `no help request with message id "${id}" (see GET /help)` });
    if (item.status === "delivered") return send(res, 409, { error: `already delivered by ${item.delivered_by}`, delivered: item });
    send(res, 200, { delivered: delivered(item, b.by, b.note) });
  });
  // The original way: send a responder to the top request (among equal scores, the one nearest the responder's level).
  if (req.method === "POST" && p === "/dispatch") return readBody(req, res, (e, b) => {
    if (e || !b || typeof b !== "object") return send(res, 400, { error: e || "need a JSON object" });
    const pick = L.pickRequest(L.queue(usable, assigned), b.block);
    if (!pick) return send(res, 200, { assigned: null });
    send(res, 200, { assigned: assign(pick, typeof b.responder === "string" && b.responder ? b.responder : "responder") });
  });
  if (req.method === "POST" && p === "/family") return readBody(req, res, (e, b) => {
    if (e || !b || !b.group || !Array.isArray(b.devices)) return send(res, 400, { error: "need group and devices[]" });
    saveMeta({ family: { group: b.group, devices: b.devices } });
    send(res, 200, { ok: true });
  });
  if (p === "/family") {
    const devs = familyOf(q.group ?? q.family); // ?group= (the original name) or ?family= (the contract's word)
    if (!devs.length) return send(res, 404, { error: "unknown group" });
    return send(res, 200, devs.map((d) => {
      const last = O.newest(usable.filter((r) => r.device === d && isOk(r)));
      return { device: d, last_ok: last ? last.time : null, block: last ? last.block : null, hops: last ? last.hops : null, via: last ? last.via : null };
    }));
  }
  if (p === "/inbox") {
    if (!q.device) return send(res, 400, { error: "device required" });
    const afterSeq = Number(q.after_seq) || 0; // relays pass the last seq they forwarded to get only new alerts
    return send(res, 200, readings.filter((r) => r.kind === "alert" && r.seq > afterSeq &&
      ((r.values.to && r.values.to.includes(q.device)) ||
       (!r.values.to && readings.some((x) => x.device === q.device && (x.block === r.block || (r.values.blocks || []).includes(x.block)))))));
  }
  if (req.method === "POST" && p === "/official") return readBody(req, res, (e, b) => {
    if (e || !b || !b.block || typeof b.count !== "number") return send(res, 400, { error: "need block and count" });
    saveMeta({ official: { block: b.block, count: b.count } });
    send(res, 200, { ok: true });
  });
  // CONTRACT.md section 4: everything the public broadcast page shows, in one call
  if (p === "/broadcast") return send(res, 200, SURF.broadcast(usable));
  if (p === "/surface") return send(res, 200, SURF.surface(usable));
  if (p === "/surface/history") return send(res, 200, SURF.surfaceHistory(readings));
  if (p === "/firstwave") {
    const n = q.n === undefined ? LIM.val("firstwave_default_n") : Math.floor(Number(q.n));
    if (!(n >= 1)) return send(res, 400, { error: "n must be a whole number of 1 or more" });
    const sv = SURF.surface(usable);
    const openHelp = new Set(L.queue(usable, assigned).map((x) => x.device));
    // the list is always ranked, but it is only a go when the surface verdict allows people up at all
    const cleared = sv.verdict === SURF.SUITS || sv.verdict === SURF.DOMES; // outposts are not a place to send a first wave
    return send(res, 200, { surface_verdict: sv.verdict, cleared,
      note: cleared ? `Surface verdict is "${sv.verdict}": this is the order people go up.`
        : `Surface verdict is "${sv.verdict}": nobody goes up yet. This is the order they would go.`,
      ...SURF.firstwave(usable, openHelp, PEOPLE, n) });
  }
  if (p === "/status") {
    const now = Date.now(), windowMin = LIM.val("status_alert_window_min");
    const recent = readings.filter((r) => r.kind === "alert" && Date.parse(r.time) >= now - windowMin * 60e3);
    const queue = L.queue(usable, assigned, now);
    const truth = L.truth(usable, official, now);
    const sv = SURF.surface(usable);
    const data = readings.filter((r) => r.kind !== "alert"); // what devices sent; alerts are ours
    const count = (f) => data.filter(f).length;
    return send(res, 200, {
      time: new Date(now).toISOString(),
      seq: lastSeq, // the newest event id: pass it to /feed?lastEventId= or /history?after_seq= to continue from here
      forecast: [...new Set(usable.filter((r) => r.kind === "power").map((r) => r.block))].sort().map((b) => L.forecast(usable, b)),
      alerts: { window_min: windowMin, count: recent.length,
        by_level: { info: 0, warn: 0, danger: 0, ...Object.fromEntries(["info", "warn", "danger"].map((l) => [l, recent.filter((a) => a.values.level === l).length])) },
        latest: recent.slice(-LIM.val("status_alert_max")).reverse() }, // newest first
      queue: { length: queue.length, top: queue[0] || null },
      truth: { window_h: truth.window_h, residents_total: truth.residents_total, official_total: truth.official_total,
        gap: truth.residents_total - truth.official_total, blocks: truth.blocks },
      surface: { verdict: sv.verdict, reasons: sv.reasons, missing: sv.missing, source: sv.source },
      blocks: blockSources(), // per block: is its newest data live hardware or simulated?
      readings: { total: data.length, verified: count((r) => r.verified === true), unverified: count((r) => r.verified !== true),
        implausible: count((r) => r.plausible === false), // sensor errors: stored, used for nothing
        live: count((r) => r.source === "live"), simulated: count((r) => r.source !== "live") },
      feed_clients: clients.size,
    });
  }
  // CONTRACT.md section 4.1: the public log of forged readings (refused, never stored as readings). ?after=<n> for new ones.
  if (p === "/forgeries") {
    const after = Number(q.after) || 0;
    return send(res, 200, { count: forgeryCount, rate_limited: forgeryLimited, kept: forgeries.length,
      forgeries: forgeries.filter((f) => f.n > after),
      rule: `A message whose sig does not match the key on file for its device is refused and never stored as a reading. Each refusal is logged here and sent on GET /live as event: forgery, at most ${RATE_LIMIT} per device per second; the newest ${LIM.val("forgery_log_max")} are kept here.` });
  }
  if (p === "/limits") return send(res, 200, LIM.all);
  if (p === "/truth") return send(res, 200, L.truth(usable, official, q.now ? Date.parse(q.now) : Date.now()));
  send(res, 404, { error: "not found" });
}
process.on("uncaughtException", (e) => console.error("uncaught error (server keeps running):", e));
server.listen(PORT, () => console.log(`Hollow Twin API on http://localhost:${server.address().port}`));
module.exports = server;
