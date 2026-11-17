# Lane 2: Watch

An ESP32 board with a small screen and battery, a MAX30102 pulse and oxygen sensor, a temperature sensor, three buttons (help, symptom, I'm OK) and a buzzer, on a wrist strap.

- [ ] Read heart rate, blood oxygen and skin temperature every few minutes; send a `vitals` message.
- [ ] Send `button` messages for help and symptom, and a `checkin` for I'm OK.
- [ ] Send everything to the nearest relay box over Bluetooth Low Energy.
- [ ] Buzz and show the text of any warning the relay passes down.

Fallback if parts are late: a phone web page with the same three buttons that posts to `/ingest`.

## The family watch: [`web/index.html`](web/index.html)

The fallback, built. One file, no install: the watch's software on a phone, plus the family app it pairs with.

**On the watch** (three screens, tabs at the bottom):

- **Home:** a big **I'M OK** button and a **NEED HELP** button (two taps, so a bump doesn't call for help).
- **Family:** who in the family is safe, who needs help, and who hasn't been heard from.
- **Talk:** walkie-talkie presets ("On my way", "Stay where you are", "Meet at the lift", "Need water") and a **Morse key**: tap for a dot, hold for a dash, a pause ends the letter. Morse that arrives is played back as beeps and vibration, with the dots and dashes on screen.

**In the family app** (next to the watch): everyone's status with where and when they were last heard from, and the whole radio message history.

**When the Directorate cuts the network** (the **Cut network** button), every message still gets through, by radio: the screen shows it hop from the watch to its block's relay, to the next block's relay (which still has a line out), and up to the API. It arrives with `hops: 2` and `via` naming both relays (CONTRACT.md section 5); on L7 Chalk Cut that is the scenario's own route. **The relays are simulated** (a phone has no radio for this), and the screen says so. A real outage (no signal, API down) holds messages on the phone with their original `time` and posts them as one array when the API is back.

### How it uses the API

Every message is a contract `checkin` to `POST /ingest`, with `source: "live"` because a real person pressed it. The API already passes a check-in's `status` to everyone in the family group, so the status carries the message:

| `status` | Means |
| --- | --- |
| `ok` | I'm safe |
| `help` | I need help. A `button` `help` message goes out too, so the call also reaches the rescue queue (`GET /help`). |
| `msg:<text>` | A walkie-talkie preset |
| `morse:<text>` | A message keyed in Morse |

**For lane 1:** CONTRACT.md lists only `ok` for `status`. The API accepts the others today; if you agree, add these values to the contract (or say if you'd rather have a `message` kind).

Family news comes back from `GET /inbox` (each alert's `status`, `sent`, `hops` and `via`) and `GET /family` (who last said OK). The first time, the watch registers itself and its family with `POST /family`.

### Connected to the twin

The twin shows every watch message in its **Family check-ins** panel and its log: "watch-0071 in Chalk Cut needs help … It crossed 2 relays (Chalk Cut to Ash Wells)". A help call also shows in the help queue. A copy of this page is deployed with the twin at `/watch` (see [`twin/README.md`](../../twin/README.md)), and on that site a new watch uses the API the twin is connected to. Once the API is hosted, set `TWIN_API` near the top of the file to its `https://` address.

### Try it on your own (no API, no install)

Open the page with no API address and it runs in **local mode**: the messages stay in your browser, and Mom and Dad answer on their own (Mom says she's safe, or "On my way" when you call for help; Dad answers in Morse). Turn that off in Settings to play both sides yourself: open the page in a second tab with `#mom` on the end.

### Try it: two family members talking

```sh
cd api && npm start                       # the API on :8787
cd firmware/watch/web && python3 -m http.server 8000
```

- **Maya** on L7 (the default): http://localhost:8000/?api=http://localhost:8787
- **Mom** on L1, in another browser or a private window: http://localhost:8000/?api=http://localhost:8787&device=watch-0011&name=Mom&block=l1-winch-gallery&to=watch-0071=Maya,watch-0012=Dad

Dad never checks in, so he shows "No word". For two phones on the same Wi-Fi, use the laptop's address instead of `localhost` in both places. Every setting can go in the link: `api`, `device`, `name`, `block`, `family`, `to`.

On camera, say "watch and family app, prototyped on a phone, with simulated relays". Real ESP32 relays would carry the same messages; nothing else changes.
