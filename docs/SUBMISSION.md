# Submission draft

Text to paste into the judging platform, and the video script. Check every field against what the platform actually asks for before using it. Numbers below come from the story's scenario on the public link; reread them off the screen before recording.

## Title

Hollow Twin

## One line

Warns the deep levels before the lights go out, shares the power that is left fairly, and gets a family's "I'm OK" through a network the Directorate switched off.

## Description (about 190 words)

In the Hollow, a power failure is not shared equally. The Directorate serves the upper levels first, the deep levels go dark for days, and when it shuts the network down, families on different levels cannot tell each other they are alive.

Hollow Twin is a live model of one sector: nine levels, 70 blocks, 32 million people. It forecasts every block's battery and warns the ones that will run dry before their lights go out. It replaces "upper levels first" with a rule anyone can check: life support for every block first, then the rest per person. In our scenario that turns 12 dark blocks into none, on the same supply. When the network is cut, relay boxes store each message, pass it block to block, and deliver a family's "I'm OK" with the route it took.

Where even the relays cannot reach, our scout rover goes: a six-wheel rocker-bogie designed in CAD, it rides the lift and drives the tunnels with a med kit, a battery pack or water filters, and its own relay box carries held messages back into range. A help press on a watch puts the request in the queue; the rover takes it, and when it arrives the watch is told.

A Node API does the forecasting, allocation and delivery; a real Arduino watch and Raspberry Pi relay hold a check-in through a real network cut, or hand it to the next block's relay, which still has a line out.

## Problems addressed

1 (blackout warning), 2 (fair sharing), 7 (organizing when the network is shut down), 8 (reconnecting families), 10 (care far from a clinic, by rover), with 5 (tunnel safety) as part of the rover's route.

## What is real and what is simulated

Real: the twin, the API (ingest, live stream, forecast, allocation, alerts, check-in delivery, replay after a cut), the shared message format, one watch (an Arduino) with one relay box (a Raspberry Pi) that holds messages through a real network cut, and relay-to-relay forwarding between two relays (the Pi and a laptop, over the local network in place of radio). Simulated: all sensor data, the population, the other 68 relays and any radio hardware. The screen labels every reading with its source.

## Links

- Video: to add (YouTube, unlisted; also put it in README.md where it says VIDEO_LINK)
- Live: https://hollow-twin.vercel.app (press Play the 75-second story)
- The family watch on a phone: https://hollow-twin.vercel.app/watch/
- The watch in 3D: https://hollow-twin.vercel.app/watch/device/
- AR, the watch on your wrist and the rover in your room: https://hollow-twin.vercel.app/ar/
- Code: https://github.com/anudeep-bonagiri/hollow-twin (public)
- Thumbnail or cover image, if the form asks for one: docs/img/hollow-twin-thumbnail.jpg

## Video script

**The current script is [`VIDEO.md`](VIDEO.md)**: eight beats in two minutes, written for online judging, opening on the real Arduino and Pi in one uncut take. The earlier six-beat version is kept below for reference.

### Earlier version: six beats, about two minutes

Record at 1440 x 900 or larger. Run the API locally (or use the hosted one) and open the twin with `?api=<API address>&intro=0`. The guided story (`?story=1`) plays beats 1 to 3 by itself with the captions on screen; turn the captions into narration instead of reading them.

| # | Seconds | On screen | Narration |
| --- | --- | --- | --- |
| 1 | 0 to 15 | The surface, then the descent to the full cutaway (story beat 1) | "This is one sector of the Hollow. Thirty-two million people on nine levels. The Directorate decides who gets power, air and news, and the deeper you live, the less you get." |
| 2 | 15 to 35 | Deepwell, blocks tagged with hours left (story beat 2) | "A geothermal unit fails. Hollow Twin forecasts every block's battery and warns the ones that will run dry, hours before the lights go out." |
| 3 | 35 to 60 | Hour 30 under the Directorate's rule, then the same hours under fair share (story beats 3 and 4) | "Under the Directorate's rule, the upper levels stay at a hundred percent and twelve deep blocks go dark. Same failure, same supply, one different rule: life support for every block first, then the rest per person. No block goes dark." |
| 4 | 60 to 85 | Split screen: a terminal running `npm run scenario -- networkcut`, and the twin. The strip at the top left shows messages arriving; "I'm OK" travels up the lift; the right panel shows the delivery | "Then the Directorate cuts the network. Relay boxes hold every message and pass it block to block. This check-in was pressed during the cut. When a relay gets through, the backend delivers it to the family's level, with the route it took. The relays here are simulated; the store, forward and delivery are real." |
| 4b | 85 to 100 | The rover rides the lift to Deepwell and drives to Bore Bend (story beat 6), then the scout page: the CAD rover pulled apart, then its tunnel mission | "Where the relays cannot reach, the rover goes. It rides the lift, drives the tunnels around the floods, and delivers what the block asked for: here a med kit. It carries a relay box too, so it brings the block's held messages back into range. We designed it in CAD, every part and joint; it is simulated, not built." |
| 5 | 100 to 115 | A block card: readings with their sources, an alert with its limit | "Every alert cites a published safety limit, and every number says where it came from. The same pieces matter after any disaster that takes out a city's grid and its phones." |

Beat 4 with the real watch and relay (docs/HARDWARE.md, "What to film"): turn the laptop's Wi-Fi off, press the Arduino's button, the Pi prints HELD; Wi-Fi back on, the Pi uploads it and the twin draws it arriving. Stronger, if it works on the bench by Wednesday: with the next block's relay running on the laptop, cut only the Pi's route to the API (docs/HARDWARE.md, step 4); the press goes Pi to laptop relay to API at once and the twin says "over 2 relays". The narration then says "two real relays, talking over the local network in place of radio".

## Before recording, check

- [ ] The header says "API connected" (or the take is the story-only version and the narration never says "backend").
- [ ] The numbers in the narration match the numbers on screen in that take.
- [ ] Nothing on screen claims a device that does not exist.
- [ ] Captions are readable at the size the platform plays video.
