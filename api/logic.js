// Hollow Twin logic moved out of the browser: forecast, fair share, help queue, family check-ins, truth check.
// Pure functions over the stored readings, so they are easy to test and the twin just displays results.
// Every number comes from shared/limits.json (via ./limits); nothing here is a hard-coded threshold.
const LIM = require("./limits");
const B = require("./blocks");
const O = require("./order");

const HOUR = 3600e3;
const t = (r) => Date.parse(r.time);

// Grid frequency outside the normal band around nominal (both from limits.json).
const gridDev = (hz) => +Math.abs(hz - LIM.val("grid_nominal_hz")).toFixed(3);
const gridOff = (hz) => LIM.crossed("grid_band_hz", gridDev(hz));
function gridWhy(hz) {
  const band = LIM.ref("grid_band_hz");
  return `grid frequency ${hz} Hz is ${gridDev(hz)} Hz from ${LIM.val("grid_nominal_hz")} Hz, outside the normal +/- ${band.value} Hz band (${band.source})`;
}

const isNum = (x) => typeof x === "number" && !Number.isNaN(x);
const isAmount = (x) => isNum(x) && x >= 0; // a measured quantity that cannot be negative
const isPositive = (x) => isNum(x) && x > 0;
const byTime = O.byTime; // oldest first; equal times by seq (CONTRACT.md section 1.3)

// Least-squares slope of y against time, per hour. Negative = falling.
function slopePerHour(pts, y) {
  const x0 = t(pts[0]);
  const xs = pts.map((p) => (t(p) - x0) / HOUR), ys = pts.map(y);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  return den ? num / den : 0;
}

// 1. Blackout forecast, per block, from `power` messages (CONTRACT.md: battery_wh, draw_w, supply_w).
//
//    Main method ("net drain"): the latest reading says how much is in the battery and how fast it is going:
//        hours_left = battery_wh / (draw_w - supply_w)        while draw_w is above supply_w
//    Fallback ("slope"): when the latest reading cannot give that (no draw_w, or only the optional battery_pct),
//    the battery level is fitted over the latest readings and extended to zero.
//
//    level: "ok", "warn" (under battery_warn_hours), "alarm" (under battery_alarm_hours, or dark), or "unknown"
//    (no usable battery reading yet). The two levels are CONTRACT.md section 6. Grid frequency (optional grid_hz)
//    gives the early warning before any battery is used.
function forecast(readings, block) {
  const power = readings.filter((r) => r.block === block && r.kind === "power").sort(byTime);
  const hz = power.filter((r) => isNum(r.values.grid_hz)).slice(-LIM.val("forecast_grid_avg_points")).map((r) => r.values.grid_hz);
  const grid_hz = hz.length ? +(hz.reduce((a, b) => a + b, 0) / hz.length).toFixed(3) : null;
  const grid_stress = grid_hz !== null && gridOff(grid_hz);
  const reasons = [];
  if (grid_stress) reasons.push(gridWhy(grid_hz));
  const out = { block, battery_wh: null, draw_w: null, supply_w: null, net_drain_w: null, hours_left: null, method: null,
    level: "unknown", dark: false, grid_hz, grid_stress, reasons, time: null, source: null };
  const last = power[power.length - 1];
  if (!last) return out;
  const v = last.values, minDrain = LIM.val("forecast_min_net_drain_w");
  out.time = last.time; out.source = last.source;
  for (const f of ["battery_wh", "draw_w", "supply_w"]) if (isNum(v[f])) out[f] = v[f];
  if (isNum(v.battery_pct)) out.battery_pct = v.battery_pct; // optional extra, only shown when a relay sends it

  if (isNum(v.battery_wh) && isNum(v.draw_w)) {
    const supply = isNum(v.supply_w) ? v.supply_w : 0; // a relay that reports no supply is running on its battery alone
    const net = +(v.draw_w - supply).toFixed(3), left = Math.max(0, v.battery_wh);
    out.method = "net drain"; out.net_drain_w = net;
    if (net > minDrain) {
      out.hours_left = +(left / net).toFixed(1);
      out.dark = left === 0;
      reasons.push(out.dark
        ? `battery empty and supply ${supply} W is below the draw of ${v.draw_w} W: the block is dark`
        : `battery ${v.battery_wh} Wh with draw ${v.draw_w} W and supply ${supply} W: net drain ${net} W gives ${out.hours_left} h left`);
    } else reasons.push(`supply ${supply} W covers the draw of ${v.draw_w} W: the battery is not draining`);
  } else {
    // slope fallback, on whichever battery level the relay reports: Wh (contract) or the optional percent
    const key = ["battery_wh", "battery_pct"].find((k) => isNum(v[k])) || ["battery_wh", "battery_pct"].find((k) => power.some((r) => isNum(r.values[k])));
    const pts = key ? power.filter((r) => isNum(r.values[key])).slice(-LIM.val("forecast_points")) : [];
    if (pts.length) {
      const level = pts[pts.length - 1].values[key], unit = key === "battery_wh" ? "Wh" : "%";
      out[key] = level;
      if (level <= 0) { out.method = "slope"; out.dark = true; out.hours_left = 0; reasons.push(`battery at ${level} ${unit}: the block is dark`); }
      else if (pts.length >= 2) {
        const slope = slopePerHour(pts, (p) => p.values[key]); // Wh per hour (= watts) or % per hour
        const flat = key === "battery_wh" ? minDrain : LIM.val("forecast_min_drain_pct_per_h");
        out.method = "slope";
        if (key === "battery_wh") out.net_drain_w = +(-slope).toFixed(3); else out.drain_pct_per_h = +slope.toFixed(2);
        if (slope < -flat) {
          out.hours_left = +(level / -slope).toFixed(1);
          reasons.push(`battery ${level} ${unit} falling ${(-slope).toFixed(2)} ${unit}/h over the last ${pts.length} readings gives ${out.hours_left} h left`);
        } else reasons.push(`battery level is steady over the last ${pts.length} readings: not draining`);
      } else reasons.push("one battery reading without draw_w: not enough to forecast yet");
    }
  }
  if (out.method) {
    const alarm = out.dark || LIM.crossed("battery_alarm_hours", out.hours_left), warn = LIM.crossed("battery_warn_hours", out.hours_left);
    out.level = alarm ? "alarm" : warn ? "warn" : "ok";
    if (!out.dark && (alarm || warn)) reasons.push(LIM.why("forecast", out.hours_left, alarm ? "battery_alarm_hours" : "battery_warn_hours"));
  }
  return out;
}

// 2. Fair share vs Directorate priority for a given supply (watts), across every block in contract/blocks.json.
// What a block needs is worked out from how many people live there. Both figures are design choices in limits.json:
//   demand_w   = people x fairshare_demand_w_per_person     everything the block runs
//   critical_w = people x fairshare_critical_w_per_person   air, pumps, medical: never shed
// Every block is sized the same way, from its people, so the 70-block table is one consistent model (megawatts).
// A real relay's own numbers (watts) never go into this table: they are reported beside it by `measured`.
function sector(blocks = B.list) {
  const demand = LIM.val("fairshare_demand_w_per_person"), critical = LIM.val("fairshare_critical_w_per_person");
  return blocks.map((b) => ({ ...b, demand_w: b.people * demand, critical_w: b.people * critical }));
}

// The blocks that have a real relay reporting: what it measured (battery_wh, draw_w, supply_w) and the forecast
// from it, tagged LIVE or SIMULATED by the message's source. Kept apart from the per-person table above.
function measured(readings) {
  const latest = {}; // block -> its newest power message
  for (const r of readings)
    if (r.kind === "power" && r.plausible !== false && O.newer(r, latest[r.block])) latest[r.block] = r;
  return Object.values(latest).sort(byTime).map((p) => {
    const f = forecast(readings, p.block), b = B.get(p.block);
    return { block: p.block, name: b ? b.name : null, level: b ? b.level : null, people: b ? b.people : null,
      tag: p.source === "live" ? "LIVE" : "SIMULATED", source: p.source, device: p.device, time: p.time, verified: p.verified === true,
      battery_wh: f.battery_wh, draw_w: f.draw_w, supply_w: f.supply_w, net_drain_w: f.net_drain_w,
      hours_left: f.hours_left, level_name: f.level, dark: f.dark, served_pct: isPositive(f.draw_w) && isAmount(f.supply_w) ? Math.min(100, Math.round((100 * f.supply_w) / f.draw_w)) : null,
      note: "What this block's own relay measured, in watts. The per-person table estimates the whole sector in megawatts; the two are never mixed." };
  });
}

// Directorate: serve upper levels fully first; deep levels get what is left.
// Fair share: every block's critical load first (air, pumps, medical), then the rest per person.
function allocate(blocks, supply_w, policy) {
  const out = blocks.map((b) => ({ ...b, served_w: 0 }));
  const sum = (k) => out.reduce((s, b) => s + b[k], 0);
  let left = supply_w;
  if (policy === "directorate") {
    for (const b of [...out].sort((a, c) => a.depth - c.depth)) { // equal depth: the order of contract/blocks.json
      b.served_w = Math.min(b.demand_w, left); left -= b.served_w;
    }
  } else {
    const crit = sum("critical_w");
    const k = crit ? Math.min(1, left / crit) : 1;
    out.forEach((b) => { b.served_w = b.critical_w * k; });
    left -= crit * k;
    // water-fill the remainder by people, capped at each block's demand
    let open = out.filter((b) => b.served_w < b.demand_w);
    while (left > 0.01 && open.length) {
      const people = open.reduce((s, b) => s + b.people, 0);
      let used = 0;
      for (const b of open) {
        const give = Math.min(left * (b.people / people), b.demand_w - b.served_w);
        b.served_w += give; used += give;
      }
      left -= used;
      open = out.filter((b) => b.demand_w - b.served_w > 0.01);
      if (used < 0.01) break;
    }
  }
  for (const b of out) {
    b.served_w = Math.round(b.served_w);
    b.served_pct = b.demand_w ? Math.round((100 * b.served_w) / b.demand_w) : 100;
    b.dark = b.served_w < Math.round(b.critical_w); // air or pumps not covered
  }
  const per = out.filter((b) => b.people > 0).map((b) => b.served_w / b.people);
  return {
    policy, supply_w,
    demand_total_w: Math.round(sum("demand_w")), critical_total_w: Math.round(sum("critical_w")), served_total_w: sum("served_w"),
    rule: policy === "directorate"
      ? "Directorate: upper levels are served in full first; deeper levels get whatever is left."
      : "Fair share: every block's critical load (air, pumps, medical) first, then the rest split per person.",
    basis: `A block's demand is ${LIM.val("fairshare_demand_w_per_person")} W per person and its critical load ${LIM.val("fairshare_critical_w_per_person")} W per person (design choices, see /limits), from the people in contract/blocks.json. Every block is sized this way; what real relays measure is reported separately under "measured".`,
    blocks: out.map(({ block, name, level, people, demand_w, critical_w, served_w, served_pct, dark }) =>
      ({ block, name, level, people, demand_w: Math.round(demand_w), critical_w: Math.round(critical_w), served_w, served_pct, dark })),
    // the comparison at a glance, per level
    levels: [...new Set(out.map((b) => b.level))].map((level) => {
      const rows = out.filter((b) => b.level === level), served = rows.reduce((s, b) => s + b.served_w, 0), demand = rows.reduce((s, b) => s + b.demand_w, 0);
      return { level, blocks: rows.length, people: rows.reduce((s, b) => s + b.people, 0), served_pct: demand ? Math.round((100 * served) / demand) : 100, dark_blocks: rows.filter((b) => b.dark).length };
    }),
    dark_blocks: out.filter((b) => b.dark).map((b) => b.block),
    equity_index: per.length && Math.max(...per) > 0 ? +(Math.min(...per) / Math.max(...per)).toFixed(2) : 0,
  };
}

// 3. Help queue: help presses ranked by a triage score from the wearer's latest vitals.
// Vital-sign limits are NEWS2 bands; the points per sign are design choices (all in limits.json).
function triageDetail(v) {
  let score = LIM.val("triage_base_points");
  const reasons = [`help pressed: ${score} points`];
  const add = (key, pointsKey, x, label) => {
    if (!LIM.crossed(key, x)) return false;
    score += LIM.val(pointsKey);
    reasons.push(`+${LIM.val(pointsKey)}: ${LIM.why(label, x, key)}`);
    return true;
  };
  if (v) {
    add("vitals_spo2_severe_below_pct", "triage_spo2_severe_points", v.spo2_pct, "SpO2") ||
      add("vitals_spo2_low_below_pct", "triage_spo2_low_points", v.spo2_pct, "SpO2");
    add("vitals_hr_high_above_bpm", "triage_hr_points", v.hr_bpm, "pulse") ||
      add("vitals_hr_low_below_bpm", "triage_hr_points", v.hr_bpm, "pulse");
    add("vitals_fever_above_c", "triage_fever_points", v.temp_c, "temperature");
  } else reasons.push("no vitals on record for this watch");
  return { score, reasons };
}
const triage = (v) => triageDetail(v).score;

// `assigned` maps a help message id to { to, time } once somebody has been sent. status: "open" (the default: nobody
// sent yet), "assigned", or "all".
function queue(readings, assigned, now = Date.now(), status = "open") {
  // open = nobody sent yet; assigned = someone is on the way; delivered = they arrived (see POST /help/<id>/delivered)
  const stateOf = (id) => { const a = assigned.get(id); return !a ? "open" : a.delivered_at ? "delivered" : "assigned"; };
  const helps = readings.filter((r) => r.kind === "button" && r.values.button === "help" &&
    (status === "all" || stateOf(r.id) === status));
  const grace = LIM.val("triage_vitals_grace_s") * 1000, per = LIM.val("triage_wait_minutes_per_point");
  return helps.map((h) => {
    const v = O.newest(readings.filter((r) => r.device === h.device && r.kind === "vitals" && t(r) <= t(h) + grace));
    const wait_min = Math.max(0, (now - t(h)) / 60e3);
    const d = triageDetail(v && v.values);
    const waited = Math.min(LIM.val("triage_wait_max_points"), Math.floor(wait_min / per)); // waiting long raises priority
    if (waited) d.reasons.push(`+${waited}: waited ${Math.floor(wait_min)} min (1 point per ${per} min, design choice)`);
    const a = assigned.get(h.id);
    return { id: h.id, device: h.device, block: h.block, time: h.time, score: d.score + waited, vitals: v ? v.values : null, reasons: d.reasons,
      status: stateOf(h.id), assigned_to: a ? a.to : null, assigned_at: a ? a.time : null,
      delivered_by: a && a.delivered_at ? a.delivered_by : null, delivered_at: a && a.delivered_at ? a.delivered_at : null, note: a && a.note ? a.note : null,
      hops: h.hops, via: h.via, source: h.source };
  }).sort((a, b) => b.score - a.score || t(a) - t(b));
}

const levelOf = B.levelOf; // how deep a block is, from contract/blocks.json (0 = the top level)

// Pick the top-priority request; among equal scores, the one nearest the responder's level.
function pickRequest(q, responderBlock) {
  if (!q.length) return null;
  const top = q.filter((r) => r.score === q[0].score);
  if (!responderBlock) return top[0];
  const L = levelOf(responderBlock);
  return top.sort((a, b) => Math.abs(levelOf(a.block) - L) - Math.abs(levelOf(b.block) - L))[0];
}

// 4. Truth check: residents' count (symptom presses or low oxygen, distinct people) vs official count.
function truth(readings, official, now = Date.now(), windowH = LIM.val("truth_window_h")) {
  const since = now - windowH * HOUR;
  const sick = {};
  for (const r of readings) {
    if (t(r) < since) continue;
    const isSick = (r.kind === "button" && r.values.button === "symptom") ||
      (r.kind === "vitals" && LIM.crossed("vitals_spo2_low_below_pct", r.values.spo2_pct));
    if (isSick) (sick[r.block] ||= new Set()).add(r.device);
  }
  const blocks = new Set([...Object.keys(sick), ...Object.keys(official)]);
  const rows = [...blocks].map((b) => {
    const residents = sick[b] ? sick[b].size : 0, off = official[b] ?? 0;
    return { block: b, residents, official: off, gap: residents - off };
  }).sort((a, b) => b.gap - a.gap);
  const tot = (k) => rows.reduce((s, r) => s + r[k], 0);
  const low = LIM.ref("vitals_spo2_low_below_pct");
  return { window_h: windowH, residents_total: tot("residents"), official_total: tot("official"), blocks: rows,
    rule: `A resident counts once if, in the last ${windowH} h, their watch sent a symptom press or SpO2 below ${low.value}% (${low.source}).` };
}

module.exports = { forecast, sector, measured, allocate, triage, triageDetail, queue, pickRequest, truth, levelOf, gridOff, gridWhy };
