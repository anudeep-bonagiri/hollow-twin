# Contract

Every device, the API and the twin agree on what is in this file. Build against it and you never have to wait for someone else's code.

**Changing it:** only the lane 1 (backend) owner edits this file. Ask in the group chat first, then everyone pulls. Adding a new field is fine any time; renaming or removing one needs everyone's OK.

## 1. Message format

Every reading, button press and status update is one JSON message:

```json
{
  "id": "watch-0042-000387",
  "device": "watch-0042",
  "block": "l8-bore-bend",
  "time": "2026-11-18T20:00:00Z",
  "kind": "vitals",
  "values": { "hr_bpm": 104, "spo2_pct": 93, "temp_c": 38.1 },
  "hops": 0,
  "via": []
}
```

| Field | Meaning |
| --- | --- |
| `id` | Unique per message: `<device>-<counter>`. Relays and the API drop a message whose `id` they have already seen. |
| `device` | Device ID, see section 3. |
| `block` | Block ID from [`contract/blocks.json`](contract/blocks.json), or `surface` for the surface scout. |
| `time` | When it was measured, ISO 8601 in UTC. Real wall-clock time; the twin maps it onto the story clock. |
| `kind` | One of the kinds in section 2. |
| `values` | The reading itself. Fields depend on `kind`. |
| `hops` | How many relays have forwarded it. The device that measured it sends `0`. |
| `via` | Relay device IDs it passed through, in order. |

One sample of every kind is in [`contract/samples/`](contract/samples/).

### 1.1 Optional fields a device may add (lane 1)

Both are optional. A message without them is a valid contract message.

| Field | Meaning |
| --- | --- |
| `source` | `live` (real hardware) or `simulated` (scripts, replays, the twin's own simulation). Left out, the API stores `simulated`, so only a real device can claim to be live. Any other value is rejected. |
| `sig` | Proof that the device itself sent the message: lowercase hex HMAC-SHA256, keyed with that device's secret, over `id|device|block|time|kind|VALUES` (VALUES = the `values` JSON, keys sorted, no spaces). `hops` and `via` are not signed, because relays change them. Left out: stored with `verified: false`. Correct: `verified: true`. Wrong: rejected, and the rejection is made public as a forgery (section 4.1). Exact rule, test vector and ESP32 code: [`api/docs/FIRMWARE.md`](api/docs/FIRMWARE.md). |

### 1.2 Fields the API adds to a stored message (lane 1)

They appear on everything the API sends back (`/live`, `/history`, `/blocks/<block id>/latest` and so on). Devices never send them; if they do, the API overwrites them.

| Field | Meaning |
| --- | --- |
| `seq` | Server sequence number, rising by one per stored message. It is also the event id on `/live`. |
| `source` | Always present on the way out: `live` or `simulated` (section 1.1). |
| `verified` | `true` only when the message carried a valid `sig`. |
| `time_estimated`, `device_time` | Present only when the device's `time` could not be trusted (section 1.3): before 2020, or ahead of the moment the API received it. `time` is then the receive time, `time_estimated` is `true` and `device_time` is what the device sent. |
| `warnings` | A list of plain sentences about things the API accepted but the sender should fix (for example an estimated time, or an old field name). Left out when there is nothing to say. |
| `sig_unchecked` | Present when a `sig` arrived but the API holds no secret for that device, so it could not be checked. |
| `plausible`, `sensor_error`, `sensor_flags` | Present only on a sensor error (section 1.3): `plausible: false`, `sensor_error` is one sentence saying what is wrong and which limit it broke, and `sensor_flags` lists each failed check (`type`: `range`, `jump` or `drift`; `field`; the `limit`; the numbers). |

### 1.3 How the API treats the fields above (lane 1)

- `hops` and `via` are stored and passed through unchanged. If a message leaves them out, the API stores `"via": []` and `"hops": 0`.
- `time` before 2020 (an ESP32 that has not synced its clock reports 1970), or ahead of the moment the API received the message (by any amount: nothing can be measured after it arrives, so the device's clock is fast): the message is kept, `time` is replaced by the receive time, `time_estimated: true` is added, and the device's own time is kept as `device_time`. A warning is added too, except when the time is less than 1 second ahead (ordinary disagreement between two good clocks, which the builder cannot fix). A wrong clock never loses a reading and never corrupts the timeline.
- **Latest.** Wherever the API speaks of the latest message (per block and kind in `/blocks/<block id>/latest` and `/blocks`, the reading a forecast, a verdict or a triage score is built on), it is the one with the greatest stored `time`; between equal times, the one with the higher `seq` (stored later). So a device with a fast clock cannot hold "latest" (its time is the receive time, and the next honest reading is newer), and a relay backlog that arrives late with its real, older times fills in the history but never replaces a fresher reading.
- A message that cannot be used (a field missing, an unknown `kind`, a `time` that is not ISO 8601, a wrong `sig`) is rejected, and the reply says why (section 4).
- `block` must be an id from [`contract/blocks.json`](contract/blocks.json), or `surface`. Any other block is rejected, and the reply says so (with a hint when only the letter case is wrong).
- **Sensor errors.** Every device message is checked before it is stored, against design-choice limits in [`api/shared/limits.json`](api/shared/limits.json) (`plausible_*`, `jump_*`, `drift_*`): an impossible value (`range`: for example SpO2 outside 0 to 100 %, a negative flood depth); a jump (a value that moved by more than its step limit from both the device's last usable reading and its previous reading, less than an hour before: a one-off spike is caught, and a second reading at a new level confirms a real change, so it counts one reading late); or drift (the device's last 4 readings move steadily away from the median of the other sensors of the same kind on its level, ending more than the drift limit away). Such a message is kept and shown on `/history` and `/live` with `plausible: false` and a `sensor_error`, the reply's `warnings` say so, it raises no alert, and it is left out of all logic: never the latest, never in a forecast, verdict, help-queue score or count (`GET /status` counts them as `readings.implausible`). A device cannot set or clear these fields.
- A `device` id that does not match section 3 is still accepted: the stored message carries a warning instead. The same goes for a relay or sensor whose id names a different block from the one in the message. A mislabelled watch must still be able to call for help.

## 2. Kinds

| Kind | Sent by | `values` |
| --- | --- | --- |
| `power` | relay box | `battery_wh`, `draw_w`, `supply_w` |
| `vitals` | watch | `hr_bpm`, `spo2_pct`, `temp_c` |
| `button` | watch | `button`: `help`, `symptom` or `ok` |
| `checkin` | watch | `status`: `ok`; `family`: family group ID; `to`: list of watch IDs to reach |
| `water` | sensor node | `tds_ppm`, `turbidity_ntu` |
| `air` | sensor node | `co2_ppm`, `temp_c`, `humidity_pct` |
| `flood` | sensor node | `depth_cm` |
| `tunnel` | scout robot | `from_block`, `to_block`, `status`: `open` or `closed`, `reason`, `photo_url` |
| `surface` | surface scout | `co2_ppm`, `temp_c`, `radiation_usv_h`, `photo_url` |

### 2.1 Optional values and one extra kind (lane 1)

Everything in this table is optional. The rows above are unchanged.

| Kind | Addition |
| --- | --- |
| `power` | Optional `grid_hz`: the mains frequency the relay hears, in Hz. When it is present the API warns of a likely power cut as soon as it leaves the normal band around 60 Hz, before any battery is used. Optional `battery_pct`: battery charge in percent, for a relay that cannot report `battery_wh`; the forecast then falls back to fitting the level over time. |
| `button` | `button` may also be `volunteer`: the wearer offers to join the first wave to the surface (`GET /firstwave`). |
| `surface` | Optional `o2_pct` (oxygen, % by volume) and `pm25_ugm3` (fine dust, µg/m3). Every surface value is optional per message: send what you measure. The surface verdict needs all five readings (`co2_ppm`, `temp_c`, `radiation_usv_h`, `o2_pct`, `pm25_ugm3`); until a scout has sent each one at least once the verdict is `not enough data`. |
| `alert` | A new kind written only by the API (`device` is `backend`), never accepted on `/ingest`. It is how warnings travel back down to watches and to the twin. `values`: `level` (`info`, `warn` or `danger`), `text` (one line for a watch screen), `why` (the reading, the limit it crossed and the limit's source), `cause` (the `id` of the message that triggered it), and `to` (a list of watch IDs) when it is addressed to particular watches. |

### 2.2 What a `checkin` can say

Addition (lane 1): besides `ok`, a `checkin`'s `status` may be any of these.

| `status` | Means | Shown as |
| --- | --- | --- |
| `ok` | I'm OK. The default when `status` is missing. | "watch-0042 is OK" |
| `help` | I need help. Send a `button` `help` as well, so the request lands in `GET /help`. | "needs help" |
| `msg:<text>` | A short message to the family: a preset ("On my way") or typed text. | the text |
| `morse:<text>` | A message keyed in Morse, already decoded to text. | the text, marked Morse |

The API passes `status` through unchanged to every watch in `to` and the family group (the alert's `values.status`). Screens show `<text>` as plain text, never as HTML, because it is typed by a person. Keep `<text>` short: watches show about 20 characters.

## 3. Device IDs

| Device | ID pattern | Example |
| --- | --- | --- |
| Watch | `watch-<4 digits>` | `watch-0042` |
| Relay box | `relay-<block id>` | `relay-l8-bore-bend` |
| Sensor node | `sensor-<block id>` | `sensor-l7-chalk-cut` |
| Scout robot | `rover-<2 digits>` | `rover-01` |
| Surface scout | `surface-<2 digits>` | `surface-01` |

## 4. API endpoints (lane 1 builds these)

| Method and path | Does |
| --- | --- |
| `POST /ingest` | Takes one message or an array. Drops duplicate `id`s. Returns `{ "accepted": <n>, "duplicates": <n> }`. |
| `GET /live` | Server-sent events. Every accepted message is sent as `event: reading` with the message as `data`. |
| `GET /blocks/<block id>/latest` | The latest message of each kind for that block. |
| `GET /help` | Open help requests, highest priority first. |
| `POST /help/<message id>/assign` | Body `{ "to": "rover-01" }`. Marks a request as assigned. |
| `GET /broadcast` | Latest `surface` readings plus the verdict text, for the public page. |

Until the real API is up, `node tools/catcher.mjs` serves `POST /ingest` and `GET /live` on port 8788 with the same shapes.

### 4.1 The six endpoints in detail (lane 1)

The real API is in [`api/`](api/) and listens on port 8787 by default. Every response is JSON (except `/live`), and every `GET` is open to any origin. If the API is started with an `INGEST_KEY`, every `POST` needs the header `x-api-key`.

**`POST /ingest`** replies with `accepted` and `duplicates` as above, plus two extra keys:

```json
{
  "accepted": 2,
  "duplicates": 1,
  "rejected": [{ "id": "watch-0042-000390", "problems": ["unknown block \"l8-borebend\": not in contract/blocks.json ..."] }],
  "warnings": [{ "id": "watch-42-000001", "warnings": ["device id \"watch-42\" does not match CONTRACT.md section 3 ..."] }]
}
```

| Status | Meaning |
| --- | --- |
| `200` | At least one message was stored, or everything was a duplicate. Anything in `rejected` was not stored. |
| `422` | Nothing in the request could be stored. `rejected` says why (same as the catcher). |
| `400` | The body is not JSON: `{ "error": "body is not JSON" }`. |
| `401` | The API needs a key and `x-api-key` is missing or wrong. |
| `413` | The body is over 5 MB. Split the backlog into smaller arrays. |
| `429` | More than 20 single posts in one second from one device. Wait a second (`Retry-After: 1`). An array is one request and is never limited. |

**`GET /live`** sends `event: reading` for every accepted message, with the stored message as `data` (section 1.2 lists the fields the API adds). Alerts (section 2.1) arrive on the same stream as `event: alert`. Every event has an `id` (the message's `seq`). A client that reconnects with the `Last-Event-ID` header, or with `?lastEventId=<id>`, first receives everything it missed, in order, then live events. A first connection without an id gets live events only; `?lastEventId=0` replays everything. If the client's id is ahead of the server (the server's data was reset) it receives `event: reset` and then everything from the start. A relay backlog posted as one array is played out oldest first.

**Forged readings.** A message whose `sig` does not match the key the API holds for its device is still rejected (`bad signature for <device>` in `rejected`), and its values are never stored as a reading: not in `/history`, not "latest" anywhere, no alert. The rejection itself is made public, so the twin can show "FORGED: rejected":

- `GET /live` sends `event: forgery` with `data` = `{ time, device, block, kind, id, claimed_time, claimed_values, hops, via, reason, rejected: true, n }`: `time` is when the API refused it, `claimed_time` and `claimed_values` are what the message claimed, `reason` is the same sentence as in `rejected`, `n` numbers the forgeries. The event has no `id:` line, so it does not change a client's `Last-Event-ID` and is not replayed on reconnect. `/feed` never carries it.
- `GET /forgeries` is the public log: `{ count, rate_limited, kept, forgeries: [...oldest first], rule }`, the newest 1,000 entries; `?after=<n>` returns only newer ones.
- Rate limit, like `POST /ingest`: at most 20 forgeries per device per second are logged and sent; every forged message counts, also inside an array. The rest are still rejected and counted in `rate_limited`.
- A claim over 2 KB is not repeated: `claimed_values` is `null` and `claimed_bytes` gives its size.
- A forger cannot burn a message id: the genuine message with that id is still accepted when it arrives.
- Only a wrong `sig` for a device with a key on file is a forgery. No `sig` (stored `verified: false`) and a `sig` from a device with no key (stored with `sig_unchecked`) are not.

```
id: 41
event: reading
data: {"id":"watch-0042-000387","device":"watch-0042","block":"l8-bore-bend","time":"2026-11-18T20:00:00Z","kind":"vitals","values":{"hr_bpm":104,"spo2_pct":93,"temp_c":38.1},"hops":0,"via":[],"source":"simulated","verified":false,"seq":41}
```

**`GET /blocks/<block id>/latest`** returns the block and one message per kind it has sent (`404` for an unknown block; `surface` works too):

```json
{ "block": "l8-bore-bend", "name": "Bore Bend", "level": "L8", "people": 772000, "source": "live",
  "latest": { "power": { "...": "the newest power message" }, "vitals": { "...": "the newest vitals message" } } }
```

**`GET /help`** returns a list, highest priority first. Each item: `id` (the help message's id), `device`, `block`, `time`, `score`, `vitals` (the wearer's latest, or `null`), `reasons` (why it scored what it did), `status`, `assigned_to`, `assigned_at`, `hops`, `via`. Without a query it lists open requests only. `?status=assigned` or `?status=all` includes requests somebody was sent to, and `&to=rover-01` narrows that to one responder.

**`POST /help/<message id>/assign`** with `{ "to": "rover-01" }` replies `{ "assigned": { ...the request, "status": "assigned", "assigned_to": "rover-01" } }`, takes the request off the open list and sends the watch an alert ("rover-01 sent to watch-0042 in l8-bore-bend"). `404` for an unknown id, `409` if it is already assigned, `400` without `to`.

**`GET /broadcast`** returns everything the public page shows:

| Field | Meaning |
| --- | --- |
| `verdict` | Which return option the readings support: `suits OK`, `sealed domes needed`, `sealed outposts needed` or `stay underground`; or `not enough data` while one of the contract's three surface readings (`co2_ppm`, `temp_c`, `radiation_usv_h`) is still missing (the API never guesses). The optional `o2_pct` and `pm25_ugm3` can make the verdict worse when measured; the verdict does not wait for them. See 4.3. |
| `text` | The verdict as one plain sentence. |
| `reasons` | The readings and limits behind the verdict, one sentence each. |
| `readings` | One entry per surface reading: `reading`, `label`, `required`, `value`, `unit`, `status` (`ok`, one of the four options, `no data`, `not measured`), `reason`, `time`, `device`, and `limits` (each limit with its `value`, `unit`, `source`, `url`, and the `option` crossing it leads to). |
| `missing` | Required readings no scout has sent yet. |
| `not_measured` | Optional readings no scout has sent yet (`o2_pct`, `pm25_ugm3`). |
| `photo` | The newest `photo_url` with its `time` and `device`, or `null`. |
| `history` | `/surface/history`: the append-only record of every surface reading and every verdict change. |
| `source` | `live`, `simulated` or `mixed`: what the verdict rests on. |

### 4.3 The surface verdict: which return option the readings support (lane 1)

The broadcast page's verdict is one of the four return options, mildest first. Each means what the readings allow:

| Verdict | Means | A reading points here when |
| --- | --- | --- |
| `suits OK` | An open settlement: people work on the surface in suits. | Every reading measured is inside every limit. |
| `sealed domes needed` | The open air is unfit to live in, but the ground, water and temperature are fine: sealed domes with scrubbed air, farming under cover, local water. | `co2_ppm` over 5,000 ppm (OSHA PEL / NIOSH REL, 8-hour limit); `o2_pct` under 19.5 % or over 23.5 % (OSHA 29 CFR 1910.146); `pm25_ugm3` 225.5 or more (US EPA AQI Hazardous); `temp_c` 39.4 °C or more (NWS heat index Danger). |
| `sealed outposts needed` | The surface itself is unfit to live off: nothing grown or collected there can be used, or nobody can work outside. Only small sealed outposts, supplied from the Hollow. | `radiation_usv_h` over 1 µSv/h (IAEA OIL3: local produce, milk and rainwater not to be consumed); `temp_c` 51.7 °C or more (NWS Extreme Danger) or -28.3 °C or less (NWS wind chill: frostbite in 30 minutes). |
| `stay underground` | Nobody goes up. | `radiation_usv_h` over 25 µSv/h (IAEA OIL2: relocation); `co2_ppm` 40,000 ppm or more (NIOSH IDLH). |

Worst reading wins. The limits are published safety facts (`GET /limits` has every source); which option a crossed limit leads to is lane 1's design choice, with the reason in each row. Lane 4's page can show `text` as it is, or map the four verdicts to its own words.

### 4.2 More endpoints the API offers (lane 1)

All optional to use. Details and examples are in [`api/README.md`](api/README.md).

| Method and path | Does |
| --- | --- |
| `GET /status` | The whole picture in one call: forecast per block, recent alerts, help queue, outbreak totals, surface verdict, live or simulated per block. |
| `GET /history` | Stored messages in the order they were measured. Filters: `block`, `kind`, `since`, `after_seq`. This is how a network gap is replayed. |
| `GET /blocks` | The latest message of each kind for every block at once. |
| `GET /forecast` | Battery hours left per block: `battery_wh / (draw_w - supply_w)`, with `level` `ok`, `warn` or `alarm` (section 6). |
| `GET /fairshare` | Who gets power for a given supply (`supply_w` or `supply_pct`): the Directorate's rule against fair share, for all 70 blocks sized from their people, with a per-level summary. What real relays measure is reported apart, under `measured`, tagged `LIVE` or `SIMULATED`. |
| `GET /inbox` | `?device=watch-0042`: the alerts for one watch. A relay fetches these and passes them down. |
| `POST /family`, `GET /family` | Register a family group's watches; see who has checked in. |
| `POST /official`, `GET /truth` | The Directorate's published case count against the residents' own count. |
| `GET /surface`, `GET /surface/history` | The surface verdict in full, and its public record. |
| `GET /firstwave` | Who goes up first: healthy volunteers, never sole caregivers, needed skills first. |
| `POST /help/<message id>/delivered` | Body `{ "by": "rover-01", "note": "med kit" }` (`note` optional, at most 200 characters). The responder arrived: the request's `status` becomes `delivered` (with `delivered_by`, `delivered_at`, `note`), it leaves the open and assigned lists, and the resident's watch gets an alert "rover-01 reached watch-0042 in l6-flint-face: med kit". Works on an open request too. `409` if already delivered; a delivered request cannot be reassigned. `GET /help?status=delivered` lists them. |
| `GET /limits` | Every threshold the API uses, with its source. |
| `GET /forgeries` | The public log of forged readings (wrong `sig`): refused, never stored as readings. See 4.1. |
| `GET /feed`, `GET /queue`, `POST /dispatch` | Earlier names kept working: `/feed` is `/live` with unnamed events, `/queue` is `/help`, `/dispatch` assigns the top request. |

## 5. When the Directorate cuts the network

1. A relay that can't reach the API keeps every message in a queue on the device.
2. It forwards each message to the relays it can hear, adding 1 to `hops` and its own ID to `via`.
3. Any relay that has seen an `id` before drops it.
4. When any relay reaches the API again, it posts its whole queue to `POST /ingest` as one array, with the original `time` values. The twin replays the gap in order.

What the API does with that array (lane 1): it sorts it by `time` before storing, drops any `id` it has already seen (counted in `duplicates`), and sends the rest out on `/live` oldest first. The backlog's older times never replace a fresher reading as the latest (section 1.3). `GET /history` always returns messages in `time` order (equal times by `seq`), so the gap can be replayed later as well. A `checkin` that arrives this way still reaches the watches in its `to` list and its family group, and the alert it produces carries the `hops` and `via` it travelled.

## 6. Thresholds (agreed by the team)

The team agreed one set of limits: the sourced limits in 6.1. The API alerts on them, and the twin uses the same numbers, which it reads from `GET /limits` (kept in [`api/shared/limits.json`](api/shared/limits.json), each with its source and link). The twin's earlier numbers (CO2 over 2,000 / 4,000 ppm, air temperature over 39 / 43 °C, flood over 25 / 45 cm) are retired.

### 6.1 Agreed limits

| Reading | Limit | Status |
| --- | --- | --- |
| Battery left (from `power`) | warning under 24 h, alarm under 8 h or dark | agreed by the team; a design choice, because no published limit exists for battery hours |
| CO2, warning | over 1,000 ppm | agreed by the team, source: Health Canada, Residential indoor air quality guidelines: Carbon dioxide (2021), long-term exposure limit |
| CO2, alarm | over 5,000 ppm | agreed by the team, source: OSHA PEL / NIOSH REL for carbon dioxide (NIOSH Pocket Guide), 8-hour limit for workers |
| Air temperature, warning | heat index 39.4 °C or more | agreed by the team, source: US National Weather Service, heat index classification: Danger (103 °F) |
| Air temperature, alarm | heat index 51.7 °C or more | agreed by the team, source: US National Weather Service, heat index classification: Extreme Danger (125 °F) |
| Flood depth | tunnel closed over 15 cm (one level) | agreed by the team, source: US National Weather Service, Flood Safety ("six inches of fast-moving water can knock over and carry off an adult") |
| Mains frequency (`grid_hz`, optional) | power cut likely when more than 0.036 Hz from 60 Hz | agreed by the team, source: NERC, Reliability Guideline: Primary Frequency Control (2023), maximum governor deadband |

Notes on the rows:

- **Air temperature.** The thermometer reading alone is not compared. The heat index (how hot the air feels) is worked out from `temp_c` and `humidity_pct` with the National Weather Service equation, because humid air is dangerous at a much lower temperature than dry air. Example: the sample `air` message (40.2 °C at 71 % humidity) has a heat index far above 51.7 °C, so it raises the top heat alert. If a sensor sends no `humidity_pct`, `temp_c` itself is compared.
- **Flood.** One level, at 15 cm, called "tunnel closed".

### 6.2 Water cut-offs (filled in by lane 1)

Proposed by lane 1. Lane 3 still has to confirm them against the probe once it is calibrated with the clean cup and the salty cup.

| Reading | Do not drink when | Status |
| --- | --- | --- |
| `tds_ppm` | over 1,000 ppm | proposed by lane 1, source: WHO, Total dissolved solids in drinking-water (background document, 2003): water below 1,000 mg/litre is "usually acceptable to consumers". 1 mg/litre is 1 ppm in water. This is an acceptability limit; WHO sets no health-based value for TDS. |
| `turbidity_ntu` | over 5 NTU | proposed by lane 1, source: US EPA, National Primary Drinking Water Regulations: turbidity must at no time exceed 5 NTU. |

Either reading over its cut-off raises one alert, "Do not drink", for the block. The sample `water` message (840 ppm, 6.5 NTU) raises it because of the turbidity. The twin's own water layer uses a simulated "contamination index" (warning over 25, alarm over 50) that no device measures; with real probes it would use the two cut-offs above.

## Changelog (lane 1)

Additions, except the rows marked **Removed**, which say what was taken out and why. Each row says where the change is written down.

| Date | Section | Change |
| --- | --- | --- |
| 2026-11-16 | 1.1 | Optional message fields `source` (`live` or `simulated`) and `sig` (device signature). |
| 2026-11-16 | 1.2 | Fields the API adds on the way out: `seq`, `source`, `verified`, `time_estimated`, `device_time`, `warnings`, `sig_unchecked`. |
| 2026-11-16 | 1.3 | Rules: missing `hops` / `via` are stored as `0` / `[]`; a `time` before 2020 or more than 5 minutes ahead is replaced by the receive time and marked. |
| 2026-11-16 | 2.1 | `button` value `volunteer`. |
| 2026-11-16 | 2.1 | `surface` optional values `o2_pct` and `pm25_ugm3`. |
| 2026-11-16 | 2.1 | Kind `alert`, written only by the API. |
| 2026-11-16 | 1.3 | Rules: a `block` that is not in `contract/blocks.json` (and is not `surface`) is rejected; a `device` id that does not match section 3 is accepted with a warning. |
| 2026-11-16 | 2.1 | `power` optional value `grid_hz` (mains frequency, the early blackout warning). |
| 2026-11-16 | 2.1 | `power` optional value `battery_pct` (for a relay that cannot report `battery_wh`). |
| 2026-11-17 | 4.1 | `POST /ingest` reply: extra keys `rejected` (with reasons) and `warnings`; status codes `422`, `400`, `401`, `413`, `429`. |
| 2026-11-17 | 4.1 | `GET /live`: alerts as `event: alert`, event ids, `Last-Event-ID` / `?lastEventId=` replay, `event: reset`. |
| 2026-11-17 | 4.1 | Response shapes for `GET /blocks/<block id>/latest`, `GET /help` (with `?status=` and `&to=`), `POST /help/<message id>/assign` and `GET /broadcast`. |
| 2026-11-17 | 4.2 | New endpoints: `/status`, `/history`, `/blocks`, `/forecast`, `/fairshare`, `/inbox`, `/family`, `/official`, `/truth`, `/surface`, `/surface/history`, `/firstwave`, `/limits`, and the earlier names `/feed`, `/queue`, `/dispatch`. |
| 2026-11-17 | 5 | What the API does with a backlog array: sorted by `time`, duplicates dropped, replayed in order on `/live`. |
| 2026-11-17 | 6.1 | Proposed limits with sources for CO2, air temperature (heat index), flood depth and mains frequency, beside the twin's numbers. The twin's table is unchanged. |
| 2026-11-17 | 6.2 | The open water item filled in: `tds_ppm` over 1,000 ppm (WHO) or `turbidity_ntu` over 5 NTU (US EPA) means do not drink. |
| 2026-11-17 | 4.1, 4.3 | Surface verdict covers all four return options (`sealed outposts needed` added); only the contract's three surface readings are required, `o2_pct` and `pm25_ugm3` are optional and listed in `not_measured`; each limit says which option it leads to. |
| 2026-11-17 | 4.2 | `GET /fairshare`: one per-person model for the table, `levels` summary, and a separate `measured` section for blocks with a real relay. |
| 2026-11-17 | 1.2, 1.3, 5 | Clock rule: any `time` ahead of the receive time (not only more than 5 minutes ahead) is replaced by the receive time, with `time_estimated: true` and `device_time`. "Latest" per block and kind is the greatest stored `time`, ties broken by `seq`; a late relay backlog never replaces a fresher reading. |
| 2026-11-17 | 6, 6.1 | The sourced limits in 6.1 are agreed by the team; the twin reads them from `GET /limits`. **Removed:** the twin's old thresholds table (CO2 2,000 / 4,000 ppm, air temperature 39 / 43 °C, flood 25 / 45 cm) and the "water is still open" line (6.2 fills it in). |
| 2026-11-17 | 1.1, 4.1, 4.2 | Forged readings are visible: a message with a wrong `sig` is still rejected and never stored as a reading, and the rejection goes out on `GET /live` as `event: forgery` and into the public log `GET /forgeries`, rate-limited like `POST /ingest`. |
| 2026-11-17 | 1.2, 1.3 | Sensor errors: an impossible value, a jump or drift is stored with `plausible: false`, `sensor_error` and `sensor_flags`, raises no alert, and is left out of all logic; `GET /status` counts them as `readings.implausible`. |
| 2026-11-17 | 2.2 | `checkin.status` may also be `help`, `msg:<text>` or `morse:<text>` (the lane 2 family watch). The API already passed any status through; this writes the values down. |
| 2026-11-17 | 4.2 | `POST /help/<message id>/delivered` closes a help request when the responder arrives and tells the resident; `GET /help` accepts `?status=delivered`. Proposed on branch `lane1-help-delivered` for lane 1 to review. |
