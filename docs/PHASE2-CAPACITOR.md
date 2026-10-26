# Phase 2: wrapping DriveCrew as a native app

This is **not built**. It is the plan for the one thing the web version cannot
do, written down so the work is a day rather than a rewrite.

## What it buys you

True background tracking. The app keeps recording with the screen off, in your
pocket, or while you use another app, and it can start itself when the car's
Bluetooth connects. That is the only reason to do this.

## What it costs

| | Cost | Needed for |
|---|---|---|
| Apple Developer Program | $99/year | iPhone, TestFlight or App Store |
| Google Play Console | $25 once | Play Store |
| Sideloaded APK | free | Android, no store |

Android can be done for nothing by building an APK and sending it to your
friends. iPhone cannot: Apple requires a paid account for anything beyond a
7-day self-signed build.

## Why the swap is small

Three modules touch platform APIs, and each hides behind a tiny interface:

| Module | Interface |
|---|---|
| `js/gps.js` | `start({ onSample, onError })`, `stop()` |
| `js/motion.js` | `start({ onReading })`, `stop()` |
| `js/wakelock.js` | `request()`, `release()` |

`js/tripEngine.js` is pure. It takes samples and returns events, with no DOM,
no browser APIs and no clock of its own. The native build feeds it samples from
a background service and **nothing in it changes**. The same is true of
`performance.js`, `geo.js`, `score.js`, `records.js` and `exporters.js` — which
is also why they are the parts under unit test.

## Steps

```bash
npm init -y
npm i @capacitor/core @capacitor/cli
npx cap init DriveCrew com.example.drivecrew --web-dir=.
npm i @capacitor-community/background-geolocation
npx cap add ios
npx cap add android
```

Then write `js/gps.native.js` exporting a `createBackgroundGpsSource()` with the
same two methods, mapping the plugin's callback to the sample shape
`{ t, lat, lon, speed, acc, heading, alt }`. Pick between them in `main.js`:

```js
const source = window.Capacitor?.isNativePlatform()
  ? createBackgroundGpsSource()
  : createGeolocationSource();
```

### iOS configuration

In `ios/App/App/Info.plist`:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>DriveCrew records your drives.</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>DriveCrew records your drives even when the screen is off.</string>
<key>NSMotionUsageDescription</key>
<string>DriveCrew measures cornering and braking forces.</string>
<key>UIBackgroundModes</key>
<array><string>location</string></array>
```

Apple reviews background location use. Say plainly that the app records drives
for the user, and that nothing is sold or shared.

### Android configuration

In `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
```

The plugin runs a foreground service with a persistent notification. That is
required on Android 10+ and is not optional.

## What to change in the UI afterwards

Several things in the app currently tell the truth about the web version's
limits. They would become wrong:

- The note under the Drive screen about keeping the app open.
- The "Tracking paused while you were away" banner (`refreshDriveScreen`).
- The "What it cannot do" section on the About screen.
- The whole Help screen, since the car-connect automation stops being needed.
- The wake lock, which can simply be dropped.

Grep for "screen on" before shipping a native build.
