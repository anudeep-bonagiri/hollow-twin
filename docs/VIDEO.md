# The 3-minute video

This is an online hackathon: judges never meet us. The video is the whole presentation, and some judges stop watching early, so **the first 15 seconds have to stand on their own**. Every number spoken is read off the screen in that take.

**Length: aim for 3:00. The hard limit is 3:15.** If a take runs long, shorten beat 8 first. Record at 1920 x 1080. **Burn the captions in**: many judges watch muted. Use our own voices. The thumbnail is [`img/hollow-twin-thumbnail.jpg`](img/hollow-twin-thumbnail.jpg).

## Shot list and narration

About 350 spoken words: a calm pace, not a rush.

| # | Time | On screen | Narration (word for word) |
| --- | --- | --- | --- |
| 1 | 0:00–0:15 | **One continuous take, no cuts**: a hand unplugs the router. It presses the Arduino's I'M OK button. The Pi's terminal prints `HELD`. The router goes back in; the Pi prints the upload, the twin draws "I'm OK" travelling up the lift, and Mom's phone watch buzzes "Dad is safe" | "The network is down. Dad presses one button. His message waits in the relay box, and the moment a line opens, his family knows he's alive." |
| 2 | 0:15–0:22 | Title card ([`img/title-card.jpg`](img/title-card.jpg)): the Directorate's poster stamped FALSE | "This is Hollow Twin." |
| 3 | 0:22–0:45 | Twin, story beat 1: the descent into the Hollow, the cutaway of nine levels | "Thirty-two million people live underground in the Hollow, in seventy blocks across nine levels. The Directorate controls the power, the network, and the numbers. And the deeper you live, the less you get." |
| 4 | 0:45–1:25 | Story beats 2 to 4: the geothermal unit fails at hour 4; blocks tagged with hours left; hour 30 under the Directorate's rule; the same hours under fair share | "When a geothermal unit fails, Hollow Twin forecasts every block's battery, hour by hour, and warns the blocks about to go dark before it happens. Under the Directorate's rule, upper levels first, twelve deep blocks are dark by hour thirty. That's eight and a half million people without air fans. Same failure, same power, one fair rule: life support first, then shared per person. No block goes dark." |
| 5 | 1:25–1:55 | The family watch on a phone, filmed in a hand: tap I'M OK, the family list; cut the network, hold HELP; the radio route lights up; Mom's watch turns red | "Families wear our watch. One tap says I'm OK, and everyone in the family sees who is safe. When the Directorate cuts the network, the watches keep talking. A help call hops radio relay to relay until it reaches the family." |
| 6 | 1:55–2:15 | The 3D watch page: "Lung sickness" preset, HELP held, the help queue ranks the call at 115 | "Every help call joins the rescue queue, ranked by the caller's blood oxygen and pulse using NEWS2, the early warning score hospitals use. This caller's oxygen is eighty-nine, so they go to the top." |
| 7 | 2:15–2:35 | AR: the watch on a real wrist through the phone camera; the scout rover placed on a real floor. Then the twin: the rover riding the lift to Deepwell | "You can try the watch on your own wrist, right in your browser. And where even the relays can't reach, our scout rover drives the tunnels with a med kit, and brings the cut-off block's messages back out." |
| 8 | 2:35–2:50 | The "How it works" diagram; the Arduino and Pi on the desk; the public `/forgeries` log showing a rejected fake reading; the 3D watch's Parts tab | "Under the hood: a real Arduino and Raspberry Pi relay, a live API on Azure where every reading is signed, so a faked one is caught and logged in public, and a watch designed part by part in CAD, about sixty-four dollars to build." |
| 9 | 2:50–3:05 | The README's "What is real and what is simulated" table, then the end card ([`img/end-card.jpg`](img/end-card.jpg)) | "Every alert cites a published safety standard, and every number says where it came from. The Arduino and Pi are real; the rover and radios are designed, not built. Hollow Twin. We count ourselves." |

## Getting each shot

- **Beat 1 (the most important 15 seconds):** follow [`HARDWARE.md`](HARDWARE.md), "What to film". Keep the router, the Arduino, the Pi's screen and the phone in one frame, or split-screen the Pi's terminal next to the camera, but **never cut inside the take**. The phone watch is Mom: open `/watch/?api=<API>&device=watch-0011&name=Mom&block=l1-winch-gallery&to=watch-0071=Maya,watch-0012=Dad` and enter the key in Settings. Never show the key on screen.
- **Beats 3 and 4:** open the twin with `?intro=0` and press **Play the 75-second story** (or `?story=1`). Leave the API empty: live data changes the 12-blocks number. Record the beats, then trim the waiting in the edit.
- **Beat 5:** `/watch/` on a phone in demo mode: I'M OK, then cut the network, then hold HELP.
- **Beat 6:** `/watch/device/?api=<API>` with the key in **Connect**, the "Lung sickness" preset on, and HELP held. The API scores that call 115.
- **Beat 7:** `/ar/` on a phone. For the wrist: good light, the back of the wrist toward the camera. For the rover: **View in your room**, pointed at the floor. Screen-record the phone.
- **Beat 8:** the README's "How it works" diagram, then `<API>/forgeries` in a browser after sending one reading with a bad signature, then the Parts tab on `/watch/device/`. No terminal scrolling.

## Before uploading

- [ ] Runtime is under 3:15.
- [ ] The first 15 seconds make sense with the sound off.
- [ ] Every number spoken is on screen in that take (12 blocks, hour 30, 8.5 million, 115).
- [ ] Nothing claims a device that does not exist: "designed, not built" for the rover and radios.
- [ ] No API key is visible in any frame.
- [ ] The captions are readable on a phone.
- [ ] Uploaded (YouTube, unlisted), played once in a logged-out browser, and the link put in `README.md` (`VIDEO_LINK`) and in the submission.
- [ ] A second take is saved as a backup.
