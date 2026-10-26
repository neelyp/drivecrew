# DriveCrew

A free drive tracker for you and your friends. It records a drive, keeps the
history on your phone, and puts a shared leaderboard in front of your mates.

No subscription, no paid tier, no adverts, no analytics, no accounts with your
email in them. Every feature is available to everyone, which is the point.

Works on iPhone and Android as an installable web app (PWA). Nothing to buy and
nothing to publish to an app store.

---

## Run it locally

```bash
node tools/serve.js
```

Then open <http://localhost:8080>. That is the whole setup — no install step, no
build step, no dependencies. Node 18 or newer.

Geolocation needs HTTPS everywhere except `localhost`, which browsers exempt.

Run the tests with:

```bash
node --test tests/
```

---

## Try it without driving anywhere

Settings → turn on **Developer tools** → pick a track and a speed.

The simulator replays a synthetic drive through exactly the same engine,
filters and screens a real drive uses. Sample timestamps keep their real
one-second spacing however fast you replay, so the 6-second start confirmation
and the 3-minute auto-stop behave as they would on the road — 60× just means a
10-minute drive finishes in 10 seconds.

Three tracks: a city loop with two red lights, a highway run, and a
closed-course pull for the performance timing screens.

---

## What it records

**Every drive:** live speed, distance, duration, moving and stopped time,
average and top speed, g-force, elevation gain and loss, and a speed-coloured
route you can scrub through.

**Performance timing** (Settings → Show performance timing): 0–30, 0–60 and
0–100 mph, 60–130 mph roll-on, eighth and quarter mile with trap speed,
60–0 mph braking distance, peak lateral g, and an estimated peak horsepower if
you have given the car a weight. Metric equivalents are measured at the same
time, so switching units never loses a record.

**Everything else:** a garage of cars with per-car stats and fuel cost
estimates, personal records, weekly and monthly trends, a smoothness score,
17 awards, share cards, and exports to GPX, GeoJSON, CSV and JSON.

All of it is local and all of it is free.

---

## The honest limitation

**DriveCrew cannot record in the background.** It is a web app, so the operating
system suspends it when the screen goes off or you switch to another app, and a
suspended page receives no location updates at all. iOS is stricter than
Android, but neither allows it.

In practice: **put the phone in a mount and leave DriveCrew open with the screen
on.** It keeps the screen awake for you while a drive is running.

It also cannot launch itself when you get in the car. You can set that up once
per phone, though — see below.

Breaks longer than 20 seconds are marked as gaps. The app never draws a straight
line across missing data or counts distance it did not see.

If background recording matters to you, `docs/PHASE2-CAPACITOR.md` explains how
to wrap this same code as a native app. It needs a paid developer account, which
is why it is not the default.

### Making it open when you get in the car

In the app: **Settings → Open automatically when I get in the car**, which shows
the steps with your own URL filled in.

- **iPhone:** Shortcuts → Automation → **+** → CarPlay (or Bluetooth, and pick
  your car) → Connects → Run Immediately → add **Open URL** with the app's address.
- **Android:** Google Assistant Routines → starter "Bluetooth device connects"
  → pick your car → action to open a web page. Tasker does the same with more control.

Once it is open on screen, DriveCrew detects movement and starts the drive itself.

---

## Installing it on a phone

- **Android (Chrome):** open the site, then the menu → **Install app**. A button
  also appears in Settings when the browser offers one.
- **iPhone (Safari):** open the site, tap **Share**, then **Add to Home Screen**.
  It must be Safari; Chrome on iOS cannot install a web app.

Installing gives it a home-screen icon and a full screen with no browser chrome.

---

## Setting up crews

**You can skip this entirely.** With no Firebase config, DriveCrew runs in
local-only mode: tracking, history, records, awards, performance timing and
share cards all work, and the Crew tab explains it is not set up. Crews only add
a shared leaderboard.

These steps are the only manual part of the whole project, and they need a
Google account.

1. Go to <https://console.firebase.google.com> and **create a project**. Decline
   Google Analytics. Stay on the **Spark** plan — do not add billing. Spark is
   free, does not expire, and does not pause the project.
2. **Authentication** → Get started → **Sign-in method** → enable **Anonymous**.
3. **Firestore Database** → Create database → **Production mode** → pick a
   region near you.
4. Still in Firestore → **Rules** tab → replace everything with the contents of
   [`firestore.rules`](firestore.rules) → **Publish**. Do not skip this: the
   rules are what stop strangers reading your crews.
5. **Project settings** (gear icon) → *Your apps* → **Web** (`</>`) → register
   the app → copy the `firebaseConfig` object.
6. Paste those values over the placeholders in
   [`firebase-config.js`](firebase-config.js).
7. Once you know your hosting address: **Authentication → Settings → Authorized
   domains → Add domain**, and add it.

Reload the app and the Crew tab becomes a leaderboard.

### About those config values

They are **not secrets**. A Firebase web config ships to every browser that
loads the app, by design. What protects your data is `firestore.rules`, which is
why step 4 matters more than any of the others.

So committing your filled-in `firebase-config.js` is normal and safe — it is
what gets served to browsers anyway. The repository ships it with placeholders,
and `firebase-config.example.js` keeps a pristine copy if you want to reset it.

The one thing you must not skip is step 4. Without the rules, a production-mode
database denies everything and crews simply will not work; with permissive test
rules, anyone could read your crews.

### How crews work

- Anonymous sign-in only. No email, no password, no phone number.
- Creating a crew gives a 6-character code from an alphabet with no I, L, O, 0
  or 1 in it, so it survives being read out loud.
- **Anyone with the code can join.** That is deliberate for a group of friends.
  If a code leaks, delete the crew and make a new one.
- A user can be in several crews.

### What is shared, exactly

When a drive finishes, and only if "Share finished drives with my crews" is on,
each of your crews receives: your display name, car label, start time, top
speed, distance, duration, peak g, smoothness score and best 0–60.

**Your route never leaves the device.** No coordinates, no start or end place,
no map data. `summaryFor()` in `js/crew.js` builds the only object that is ever
uploaded, and `firestore.rules` rejects any document containing `lat`, `lon`,
`segments` or `points` even if a modified client tried to send them.

You can narrow it further per device: Settings → **What to share** → "Top speed
only".

Leaderboard numbers come from each person's own phone. Nothing verifies them, so
treat it as a friendly scoreboard among people you know rather than a record
book.

---

## Deploying

Geolocation requires HTTPS. Both options below provide it free.

### GitHub Pages

```bash
git add -A && git commit -m "DriveCrew"
gh repo create drivecrew --public --source=. --push
gh api -X POST repos/:owner/drivecrew/pages -f build_type=legacy \
  -f 'source[branch]=main' -f 'source[path]=/'
```

Or in the browser: push the repository, then Settings → Pages → deploy from
`main` / root. The site appears at `https://<you>.github.io/drivecrew/`.

Every path in the app is relative and routing is hash-based, so it works from a
subdirectory with no server rewrites.

### Firebase Hosting

```bash
npm i -g firebase-tools
firebase login
firebase use --add            # pick the project from "Setting up crews"
firebase deploy
```

`firebase.json` is already configured: it serves the project root, excludes
`tests/`, `tools/` and `docs/`, and sends no-cache headers for `index.html` and
`sw.js` so updates are picked up. `firebase deploy --only firestore:rules`
publishes the rules without touching the site.

### Anywhere else

It is a folder of static files. Cloudflare Pages, Netlify, Vercel, S3 and a
plain nginx all work. There is nothing to build.

---

## How trip detection works

The state machine lives in [`js/tripEngine.js`](js/tripEngine.js) and is pure —
no DOM, no browser APIs, no clock of its own. It takes samples and returns
events, which is what makes it testable and what makes a native wrapper easy.

`idle → candidate → recording → ended`

| Setting | Default | Meaning |
|---|---|---|
| `MAX_ACC_M` | 30 m | Ignore fixes less accurate than this |
| `START_SPEED_MS` | 4.5 m/s (~10 mph) | Counts as driving |
| `START_CONFIRM_S` | 6 s | Must hold that speed this long to start |
| `STOP_SPEED_MS` | 1.0 m/s | Counts as stopped |
| `END_STOP_S` | 180 s | Stopped this long ends the drive |
| `GAP_S` | 20 s | Longer sample gaps break the route |
| `MAX_ACCEL_MS2` | 12 m/s² | Reject impossible speed jumps |
| `MAX_SPEED_MS` | 130 m/s | Hard sanity cap |
| `MIN_TRIP_DIST_M` | 300 m | Discard shorter drives |
| `MIN_TRIP_S` | 60 s | Discard shorter drives |

Speed, auto-stop and accuracy are editable in Settings. Expect to adjust them
after your first couple of real drives.

A few decisions worth knowing:

- **Start time is backdated.** A drive begins at the first sample above the
  start speed, not six seconds later when it was confirmed.
- **End time is when you stopped,** not three minutes later when the timer
  expired. Time spent parked afterwards is not part of the drive.
- **A top speed needs two consecutive samples agreeing within 15%.** One freak
  GPS reading can never set a record. The displayed speed is smoothed (3-sample
  median, then an EMA); records use the unsmoothed value.
- **Crawling holds the auto-stop timer rather than advancing it.** The spec said
  the timer resets only above the start speed, which would end a drive after
  three minutes of stop-start traffic. Between the two thresholds the timer
  freezes instead.
- **Gaps are gaps.** No distance is added across one, and the map leaves the
  line broken.

---

## Decisions made where the brief was silent

- **One units toggle, not two.** mph implies miles, km/h implies km. Two
  controls would let you pick mph with kilometres.
- **Dark map tiles come from OpenStreetMap inverted in CSS.** CARTO's dark
  basemap now demands an API key, which would be a signup and a rate limit.
  Inverting OSM in the browser needs neither. Plain OSM and OpenTopoMap are also
  available.
- **Leaflet 1.9.4 is vendored** into `vendor/` rather than loaded from a CDN, so
  the app genuinely works offline and has no third-party runtime dependency.
- **No achievement rewards speed.** They are about distance, climbing,
  consistency and smooth driving. A badge for a fast 0–60 would be a "go faster"
  prompt, which the brief ruled out.
- **Performance timing is off by default** and asks for a closed-course
  acknowledgement the first time you turn it on.
- **Distance milestones are in kilometres for everyone.** Making them depend on
  the units setting would let an award un-earn itself when you switch.
- **The smoothness score ignores speed.** There is no speed-limit data on the
  device, so it counts harsh acceleration, hard braking and sharp cornering per
  100 km and nothing else. It is not a safety score and does not pretend to be.
- **Both unit systems' performance targets are measured on every drive,** so
  switching units reveals records rather than destroying them.
- **Icons are generated** by `tools/make-icons.js`, which contains a small PNG
  encoder so there is no image dependency. Re-run it with `npm run icons`.

## What is approximate, and how much

- **G-force** comes from `DeviceMotion` with a low-pass gravity estimate
  subtracted, so it is orientation-independent — but a phone in a cradle
  measures its own rattling too. Treat it as indicative.
- **Performance timings** are interpolated from GPS at roughly 1 Hz. Expect
  about ±0.2 s on a 0–60 and ±2 m on a braking distance. Good for comparing your
  own runs; not a dragstrip.
- **Estimated power** assumes the weight you entered plus a generic drag area
  and rolling resistance. It is a road-load calculation, not a dyno.
- **Fuel cost** assumes the car's rated economy, which no car achieves exactly.

---

## Testing

```bash
node --test tests/
```

133 tests, no dependencies, covering the pure modules: the trip state machine,
geographic maths, performance detection, scoring, records, achievements and
exporters. They include every case the brief asked for — a normal drive with a
red light, walking speed never starting a drive, a GPS spike not becoming a top
speed, a low-accuracy burst being ignored, gaps adding no phantom distance,
short drives being discarded, and a null `coords.speed` falling back to a
computed one — plus fixture replays of all three simulator tracks end to end.

### Security rules

```bash
npm i --no-save firebase-tools @firebase/rules-unit-testing firebase
npm run test:rules
```

23 tests run the real `firestore.rules` against the Firestore emulator (which
needs Java, and no Firebase account). They check that a signed-out visitor reads
nothing, a stranger cannot read a crew or its members, a crew can only be created
with yourself as owner, an invite code cannot be minted for someone else's crew
or repointed, joining creates only your own membership, summaries can only be
posted under your own uid by an actual member, summaries are immutable, and —
the important one — **any document containing `lat`, `lon`, `segments` or
`points` is refused outright**, so a modified client still cannot upload a route.

### End to end

The app itself was driven in a headless browser at 390×844: a simulated drive
auto-started, updated live, auto-ended, saved, appeared in History with a
speed-coloured map and working charts, produced correct performance timings, and
rendered a 1080×1350 share card as a non-empty PNG with no console errors.

## Privacy

Drives, routes, cars and settings live in IndexedDB on your device. Nothing is
uploaded unless you set up crews and leave sharing on, and then only the summary
figures listed above.

Map tiles are fetched from OpenStreetMap (or OpenTopoMap) as you pan, which tells
those servers which tiles were asked for. The route itself is drawn locally and
never sent. Share cards are rendered entirely on-device and contain no map tiles.

There is no analytics, no advertising, no tracking and no third-party scripts.
Firebase is loaded only if you configure it.

## Credits

Maps with [Leaflet](https://leafletjs.com) (BSD-2-Clause), vendored in
`vendor/leaflet/`. Map data © OpenStreetMap contributors (ODbL). Terrain tiles
by [OpenTopoMap](https://opentopomap.org) (CC-BY-SA).

OpenStreetMap's tile usage policy covers a friend group comfortably. If you ever
hand this to hundreds of people, run your own tile server or buy a tile plan.

An original application, not affiliated with or derived from any other drive
tracker.
