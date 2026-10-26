// Boot, routing, and every screen. Vanilla ES modules, no build step.

import { APP_NAME, APP_VERSION, SETTINGS_DEFAULTS, DEFAULTS, resolveConfig } from './config.js';
import { createTripEngine } from './tripEngine.js';
import { createGeolocationSource, locationPermissionState } from './gps.js';
import { createMotionSource, requestMotionPermission, needsMotionPermission } from './motion.js';
import { createWakeLock } from './wakelock.js';
import { createSimSource, TRACKS } from './sim.js';
import * as store from './storage.js';
import * as crew from './crew.js';
import { computeRecords, summarize, groupByPeriod, periodStart } from './records.js';
import { evaluateAchievements } from './achievements.js';
import { toGPX, toGeoJSON, tripsToCSV, tripPointsToCSV } from './exporters.js';
import { shareCard, renderShareCard } from './shareCard.js';
import { listVehicles, saveVehicle, removeVehicle, newVehicle, vehicleLabel, findVehicle, fuelEstimate } from './vehicles.js';
import { createMap, drawRoute, fitRoute, setPosition, startMarker, drawThumbnail, MAP_STYLES, setStyle } from './mapView.js';
import { speedChart, lineChart, barChart, liveTrace } from './charts.js';
import { heatColor } from './heat.js';
import {
  esc, $, $$, on, toast, openSheet, confirmSheet, statRow, fitCanvas,
  friendlyDay, clockTime, fullDate, download,
} from './ui.js';
import {
  speedIn, distanceIn, speedUnitLabel, distanceUnitLabel, shortDistanceIn, shortDistanceUnitLabel,
  formatSpeed, formatDistance, formatDuration, formatDurationLong, formatG, formatHp, accelLabel,
  msToMph, mphToMs, kmhToMs,
} from './units.js';

// --- application state ----------------------------------------------------

const app = {
  settings: { ...SETTINGS_DEFAULTS },
  vehicles: [],
  profile: null,          // { name, avatar, crews: [] }
  engine: null,
  source: null,
  motion: null,
  wake: createWakeLock(),
  armed: false,
  gpsError: null,
  lastStats: null,
  trace: [],              // the last minute of samples, for the live trace
  liveMap: null,
  tickTimer: null,
  draftTimer: null,
  installEvent: null,
  hiddenDuringTrip: false,
  simRunning: false,
  crewReady: false,
  crews: [],
};

const TRACE_WINDOW_MS = 60_000;
const sys = () => app.settings.system;

// --- boot -----------------------------------------------------------------

async function boot() {
  try {
    const saved = await store.loadSettings();
    if (saved) app.settings = { ...SETTINGS_DEFAULTS, ...saved };
    app.profile = (await store.kvGet('profile')) || null;
    app.vehicles = await listVehicles();
  } catch (err) {
    console.warn('Storage unavailable, running with defaults', err);
    toast('Storage is unavailable, so drives will not be saved.');
  }

  document.documentElement.dataset.theme = app.settings.theme || 'dark';
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    app.installEvent = e;
  });
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', flushUploads);

  registerServiceWorker();
  route();

  if (!app.settings.safetySeen) await showSafetyNotice();
  await offerDraftRecovery();
  if (app.settings.autoArm) await maybeAutoArm();
  flushUploads();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW failed', err));
}

async function saveSettings(patch) {
  app.settings = { ...app.settings, ...patch };
  try {
    await store.saveSettings(app.settings);
  } catch (err) {
    console.warn('Could not save settings', err);
  }
}

// --- safety notice --------------------------------------------------------

function safetyCopy() {
  return `<p>Put the phone in a mount before you set off. Tracking only runs while
    the app is open with the screen on, so you should not need to touch it again.</p>
    <p>Do not use the app while driving. Obey speed limits and traffic law. Keep
    performance driving to a closed course.</p>`;
}

function showSafetyNotice() {
  return new Promise((resolve) => {
    openSheet(
      `<h2>Before your first drive</h2>
       ${safetyCopy()}
       <div class="btn-row"><button class="btn btn-primary" data-act="ok">Got it</button></div>`,
      {
        onMount(panel, close) {
          on(panel, 'click', '[data-act="ok"]', async () => {
            await saveSettings({ safetySeen: true });
            close();
            resolve();
          });
        },
      }
    );
  });
}

// --- tracking -------------------------------------------------------------

function engineConfig() {
  return resolveConfig(app.settings);
}

function activeVehicle() {
  return findVehicle(app.vehicles, app.settings.activeVehicleId);
}

function makeEngine() {
  const v = activeVehicle();
  return createTripEngine({
    config: engineConfig(),
    vehicle: v ? { id: v.id, massKg: v.massKg, cdA: v.cdA, crr: v.crr } : {},
  });
}

async function maybeAutoArm() {
  const state = await locationPermissionState();
  if (state === 'granted') arm({ silent: true });
}

async function arm({ silent = false, simTrack = null, rate = 1 } = {}) {
  if (app.armed) return;

  app.engine = makeEngine();
  app.gpsError = null;
  app.trace = [];

  if (simTrack) {
    app.source = createSimSource(simTrack, { rate });
    app.simRunning = true;
  } else {
    app.source = createGeolocationSource();
    app.simRunning = false;
    if (app.settings.motion && needsMotionPermission() && !silent) {
      // iOS only grants this from inside a user gesture, which is why the
      // "Start tracking" button is the only place that calls arm() directly.
      await requestMotionPermission();
    }
    if (app.settings.motion) {
      app.motion = createMotionSource();
      app.motion.start({
        onReading: (r) => app.engine && app.engine.addMotion({ t: r.t, totalG: r.totalG }),
      });
    }
  }

  app.armed = true;
  app.source.start({
    onSample: onSample,
    onError: onGpsError,
    onComplete: () => {
      app.simRunning = false;
      refreshDriveScreen();
    },
  });

  if (app.settings.wakeLock && !simTrack) app.wake.request();

  clearInterval(app.tickTimer);
  app.tickTimer = setInterval(() => {
    if (!app.engine) return;
    const now = app.source && app.source.now ? app.source.now() : Date.now();
    handleEvents(app.engine.tick(now));
    refreshDriveScreen();
  }, 1000);

  clearInterval(app.draftTimer);
  app.draftTimer = setInterval(persistDraft, DEFAULTS.DRAFT_INTERVAL_MS);

  refreshDriveScreen();
  if (!silent && !simTrack) toast('Watching for movement.');
}

function disarm() {
  app.source?.stop();
  app.motion?.stop();
  app.wake.release();
  clearInterval(app.tickTimer);
  clearInterval(app.draftTimer);
  app.armed = false;
  app.simRunning = false;
  refreshDriveScreen();
}

function onSample(sample) {
  if (!app.engine) return;
  const events = app.engine.addSample(sample);

  app.trace.push({ t: sample.t, speed: sample.speed ?? 0 });
  const cutoff = sample.t - TRACE_WINDOW_MS;
  while (app.trace.length && app.trace[0].t < cutoff) app.trace.shift();

  handleEvents(events);
  app.lastStats = app.engine.getStats();
  refreshDriveScreen();

  if (app.liveMap && Number.isFinite(sample.lat)) {
    setPosition(app.liveMap, sample.lat, sample.lon);
  }
}

function onGpsError(err) {
  app.gpsError = err;
  if (err.code === 'denied') {
    app.armed = false;
    app.source?.stop();
    clearInterval(app.tickTimer);
  }
  refreshDriveScreen();
}

async function handleEvents(events) {
  for (const event of events) {
    if (event.type === 'tripStarted') {
      toast('Recording this drive.');
      app.hiddenDuringTrip = false;
    } else if (event.type === 'tripEnded') {
      await onTripFinished(event.trip);
    } else if (event.type === 'tripDiscarded') {
      const why = event.reason === 'distance' ? 'too short a distance' : 'too short a time';
      toast(`Drive not saved: ${why}.`);
      await store.clearDraft().catch(() => {});
    }
  }
}

async function onTripFinished(trip) {
  const vehicle = activeVehicle();
  const record = { ...trip, vehicleId: vehicle ? vehicle.id : null, vehicleName: vehicleLabel(vehicle) };
  try {
    await store.putTrip(record);
    await store.clearDraft();
  } catch (err) {
    console.warn('Could not save the drive', err);
    toast('The drive could not be saved to this device.');
    return;
  }

  await queueCrewUploads(record);
  showTripFinishedSheet(record);
}

async function persistDraft() {
  if (!app.engine) return;
  const draft = app.engine.getDraft();
  if (!draft) return;
  try {
    await store.saveDraft(draft);
  } catch {
    /* storage full or blocked: the live trip is unaffected */
  }
}

async function offerDraftRecovery() {
  let draft = null;
  try {
    draft = await store.loadDraft();
  } catch {
    return;
  }
  if (!draft || !draft.startedAt) return;

  openSheet(
    `<h2>An unfinished drive</h2>
     <p class="muted">A drive from ${esc(friendlyDay(draft.startedAt))} at
       ${esc(clockTime(draft.startedAt))} was interrupted before it finished.</p>
     ${statRow([
       { label: 'Distance', value: formatDistance(draft.distanceM, sys()), unit: distanceUnitLabel(sys()) },
       { label: 'Top speed', value: formatSpeed(draft.topSpeedMs, sys()), unit: speedUnitLabel(sys()) },
       { label: 'Time', value: formatDuration(draft.durationS) },
     ])}
     <div class="btn-row">
       <button class="btn" data-act="discard">Discard</button>
       <button class="btn btn-primary" data-act="keep">Save it</button>
     </div>`,
    {
      onMount(panel, close) {
        on(panel, 'click', '[data-act="keep"]', async () => {
          const vehicle = findVehicle(app.vehicles, draft.vehicleId);
          await store.putTrip({ ...draft, draft: false, endReason: 'recovered', vehicleName: vehicleLabel(vehicle) });
          await store.clearDraft();
          close();
          toast('Drive saved.');
          if (location.hash.startsWith('#/history')) route();
        });
        on(panel, 'click', '[data-act="discard"]', async () => {
          await store.clearDraft();
          close();
        });
      },
    }
  );
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    if (app.engine && app.engine.getState() === 'recording') app.hiddenDuringTrip = true;
  } else {
    if (app.settings.wakeLock && app.armed && !app.simRunning) app.wake.request();
    refreshDriveScreen();
  }
}

// --- crew uploads ---------------------------------------------------------

async function queueCrewUploads(trip) {
  if (!app.settings.shareWithCrews) return;
  const crewIds = (app.profile && app.profile.crews) || [];
  if (!crewIds.length) return;

  const summary = crew.summaryFor(trip, {
    name: app.profile.name || 'Anonymous',
    car: trip.vehicleName || '',
    mode: app.settings.shareMode || 'full',
  });

  for (const crewId of crewIds) {
    await store.queueUpload({
      id: `${crewId}:${trip.id}`,
      crewId,
      summary,
      queuedAt: Date.now(),
    }).catch(() => {});
  }
  flushUploads();
}

async function flushUploads() {
  if (!navigator.onLine) return;
  let pending = [];
  try {
    pending = await store.allUploads();
  } catch {
    return;
  }
  if (!pending.length) return;
  if (!(await crew.isConfigured())) return;

  const conn = await crew.connect();
  if (!conn.ok) return;

  for (const row of pending) {
    try {
      await crew.uploadSummary(row.crewId, row.summary);
      await store.removeUpload(row.id);
    } catch (err) {
      // Leave it queued; we try again on the next launch or network change.
      console.warn('Crew upload deferred', err);
      break;
    }
  }
}

// --- router ---------------------------------------------------------------

const ROUTES = [
  [/^#\/drive$/, driveScreen, 'drive'],
  [/^#\/history$/, historyScreen, 'history'],
  [/^#\/trip\/(.+)$/, tripScreen, 'history'],
  [/^#\/records$/, recordsScreen, 'history'],
  [/^#\/stats$/, statsScreen, 'history'],
  [/^#\/awards$/, awardsScreen, 'history'],
  [/^#\/crew$/, crewScreen, 'crew'],
  [/^#\/crew\/(.+)$/, crewDetailScreen, 'crew'],
  [/^#\/join\/(.+)$/, joinScreen, 'crew'],
  [/^#\/settings$/, settingsScreen, 'settings'],
  [/^#\/garage$/, garageScreen, 'settings'],
  [/^#\/vehicle\/(.+)$/, vehicleScreen, 'settings'],
  [/^#\/help$/, helpScreen, 'settings'],
  [/^#\/about$/, aboutScreen, 'settings'],
];

async function route() {
  const hash = location.hash || '#/drive';

  // Leaving the Drive screen tears the live map down so Leaflet releases it.
  if (app.liveMap) {
    app.liveMap.remove();
    app.liveMap = null;
  }

  for (const [pattern, screen, tab] of ROUTES) {
    const match = hash.match(pattern);
    if (!match) continue;
    setActiveTab(tab);
    const view = $('#view');
    view.innerHTML = '<p class="muted">Loading…</p>';
    try {
      await screen(view, ...match.slice(1));
    } catch (err) {
      console.error(err);
      view.innerHTML = `<div class="empty"><h2>Something went wrong</h2>
        <p>${esc(err.message)}</p></div>`;
    }
    view.scrollIntoView({ block: 'start' });
    return;
  }
  location.hash = '#/drive';
}

function setActiveTab(tab) {
  for (const a of $$('#tabs a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

// --- Drive screen ---------------------------------------------------------

function statusFor() {
  if (app.gpsError && app.gpsError.code === 'denied') return ['blocked', 'Location blocked'];
  if (!app.armed) return ['idle', 'Not tracking'];
  const state = app.engine ? app.engine.getState() : 'idle';
  const stats = app.lastStats;
  if (state === 'recording') {
    if (stats && stats.stopInS !== null) return ['paused', `Stopped, ending in ${formatDuration(stats.stopInS)}`];
    return ['recording', app.simRunning ? 'Recording (simulated)' : 'Recording'];
  }
  if (stats && stats.lastAccuracyM !== null && stats.lastAccuracyM > app.settings.MAX_ACC_M) {
    return ['weak', 'GPS weak'];
  }
  if (app.gpsError) return ['weak', 'Waiting for a GPS fix'];
  return ['waiting', 'Waiting for movement'];
}

async function driveScreen(view) {
  const s = sys();
  view.innerHTML = `
    <div class="statusbar">
      <span class="pill" id="statusPill"><span class="dot"></span><span id="statusText"></span></span>
      <span class="label num" id="clock"></span>
    </div>

    <div class="readout">
      <div class="readout-line">
        <span class="speed" id="speedVal">0</span>
        <span class="speed-unit">${esc(speedUnitLabel(s))}</span>
      </div>
      <canvas class="trace" id="trace" aria-hidden="true"></canvas>
    </div>

    <div id="driveStats"></div>

    <div id="hiddenBanner"></div>

    <div class="section">
      <div class="map" id="liveMap"></div>
    </div>

    <div id="driveActions" class="sticky-action"></div>

    <p class="section-note">Tracking runs only while this app is open with the
      screen on. <a href="#/help">Set it to open when you get in the car.</a></p>
  `;

  renderDriveStats();
  renderDriveActions();

  if (app.armed && window.L) {
    app.liveMap = createMap($('#liveMap'), { style: app.settings.mapStyle, interactive: false });
    if (app.lastStats && app.lastStats.position) {
      setPosition(app.liveMap, app.lastStats.position.lat, app.lastStats.position.lon);
    }
  } else {
    $('#liveMap').innerHTML = `<div class="map-note">The map appears once tracking starts.</div>`;
  }

  on(view, 'click', '[data-act="start"]', async () => {
    await arm();
    route();
  });
  on(view, 'click', '[data-act="stop"]', async () => {
    const ok = await confirmSheet({
      title: 'Stop tracking?',
      body: 'A drive in progress will be saved first.',
      confirmLabel: 'Stop tracking',
    });
    if (!ok) return;
    if (app.engine && app.engine.getState() === 'recording') {
      await handleEvents(app.engine.endNow(Date.now(), { force: true }));
    }
    disarm();
    route();
  });
  on(view, 'click', '[data-act="end"]', async () => {
    const ok = await confirmSheet({
      title: 'End this drive now?',
      body: 'It will be saved and a new drive can start straight away.',
      confirmLabel: 'End drive',
    });
    if (!ok) return;
    const now = app.source && app.source.now ? app.source.now() : Date.now();
    await handleEvents(app.engine.endNow(now, { force: true }));
    refreshDriveScreen();
  });
  on(view, 'click', '[data-act="dismiss-hidden"]', () => {
    app.hiddenDuringTrip = false;
    refreshDriveScreen();
  });

  refreshDriveScreen();
}

function renderDriveStats() {
  const s = sys();
  const st = app.lastStats || {};
  const host = $('#driveStats');
  if (!host) return;
  host.innerHTML = statRow([
    { label: 'Distance', value: formatDistance(st.distanceM || 0, s), unit: distanceUnitLabel(s) },
    { label: 'Top speed', value: formatSpeed(st.topSpeedMs || 0, s), unit: speedUnitLabel(s) },
    { label: 'Time', value: formatDuration(st.durationS || 0) },
    { label: 'Average', value: formatSpeed(st.avgSpeedMs || 0, s), unit: speedUnitLabel(s) },
    { label: 'Peak g', value: app.settings.motion ? formatG(st.peakG || 0) : '--' },
    { label: 'Moving', value: formatDuration(st.movingS || 0) },
  ]);
}

function renderDriveActions() {
  const host = $('#driveActions');
  if (!host) return;
  const recording = app.engine && app.engine.getState() === 'recording';

  if (!app.armed) {
    host.innerHTML = `<button class="btn btn-primary" data-act="start">Start tracking</button>`;
    return;
  }
  host.innerHTML = `
    ${recording ? `<button class="btn btn-primary" data-act="end">End drive now</button>` : ''}
    <div class="btn-row"><button class="btn" data-act="stop">Stop tracking</button></div>`;
}

function refreshDriveScreen() {
  if (!location.hash.startsWith('#/drive') && location.hash !== '') return;
  const pill = $('#statusPill');
  if (!pill) return;

  const [state, text] = statusFor();
  pill.dataset.state = state;
  $('#statusText').textContent = text;

  const st = app.lastStats || {};
  const speedNode = $('#speedVal');
  const shown = app.armed ? st.displaySpeedMs || 0 : 0;
  speedNode.textContent = formatSpeed(shown, sys());
  speedNode.classList.toggle('is-idle', !app.armed || state === 'blocked');

  $('#clock').textContent = st.startedAt ? formatDuration(st.durationS || 0) : clockTime(Date.now());

  renderDriveStats();
  renderDriveActions();

  const trace = $('#trace');
  if (trace) liveTrace(trace, app.trace);

  const banner = $('#hiddenBanner');
  if (banner) {
    if (app.hiddenDuringTrip) {
      banner.innerHTML = `<div class="banner">
        <h3>Tracking paused while you were away</h3>
        <p>A browser app stops receiving GPS when the screen is off or another app
          is in front. Keep DriveCrew open on a mount for the whole drive. Any
          break longer than ${DEFAULTS.GAP_S} seconds is marked as a gap rather than
          guessed at.</p>
        <div class="btn-row"><button class="btn btn-small" data-act="dismiss-hidden">Dismiss</button></div>
      </div>`;
    } else if (app.gpsError && app.gpsError.code === 'denied') {
      banner.innerHTML = `<div class="banner danger">
        <h3>Location is blocked</h3>
        <p>DriveCrew needs location access to record a drive. Allow it for this
          site in your browser settings, then reload.</p>
      </div>`;
    } else {
      banner.innerHTML = '';
    }
  }
}

function showTripFinishedSheet(trip) {
  const s = sys();
  openSheet(
    `<h2>Drive saved</h2>
     ${statRow([
       { label: 'Distance', value: formatDistance(trip.distanceM, s), unit: distanceUnitLabel(s) },
       { label: 'Top speed', value: formatSpeed(trip.topSpeedMs, s), unit: speedUnitLabel(s) },
       { label: 'Time', value: formatDuration(trip.durationS) },
     ])}
     <div class="btn-row">
       <button class="btn" data-close>Close</button>
       <button class="btn btn-primary" data-act="view">See the drive</button>
     </div>`,
    {
      onMount(panel, close) {
        on(panel, 'click', '[data-act="view"]', () => {
          close();
          location.hash = `#/trip/${trip.id}`;
        });
      },
    }
  );
}

// --- History --------------------------------------------------------------

async function historyScreen(view) {
  const trips = await store.allTrips();
  const s = sys();

  if (!trips.length) {
    view.innerHTML = `
      <div class="screen-head"><h1>History</h1></div>
      <div class="empty">
        <h2>No drives yet</h2>
        <p>Start tracking on the Drive screen and your first drive will appear here.</p>
        <div class="btn-row" style="justify-content:center">
          <a class="btn btn-primary btn-small" href="#/drive">Go to Drive</a>
        </div>
      </div>`;
    return;
  }

  const totals = summarize(trips);
  const filter = app.historyFilter || 'all';
  const shown = trips.filter((t) => {
    if (filter === 'fav') return t.favorite;
    if (filter.startsWith('v:')) return t.vehicleId === filter.slice(2);
    return true;
  });

  const vehicleChips = app.vehicles
    .map((v) => `<button class="chip" data-filter="v:${esc(v.id)}" aria-pressed="${filter === `v:${v.id}`}">${esc(vehicleLabel(v))}</button>`)
    .join('');

  view.innerHTML = `
    <div class="screen-head"><h1>History</h1></div>

    ${statRow([
      { label: 'Drives', value: String(totals.trips) },
      { label: 'Total distance', value: formatDistance(totals.distanceM, s), unit: distanceUnitLabel(s) },
      { label: 'Time driving', value: formatDurationLong(totals.movingS) },
    ])}

    <div class="btn-row">
      <a class="btn btn-small" href="#/records">Records</a>
      <a class="btn btn-small" href="#/stats">Trends</a>
      <a class="btn btn-small" href="#/awards">Awards</a>
    </div>

    <div class="section">
      <div class="scroll-x" style="margin-bottom:4px">
        <button class="chip" data-filter="all" aria-pressed="${filter === 'all'}">All</button>
        <button class="chip" data-filter="fav" aria-pressed="${filter === 'fav'}">Favourites</button>
        ${vehicleChips}
      </div>
      <ul class="list" id="tripList">
        ${shown.map(tripRow).join('')}
      </ul>
      ${shown.length === 0 ? '<p class="muted" style="padding:20px 0">Nothing matches that filter.</p>' : ''}
    </div>
  `;

  for (const canvas of $$('canvas[data-thumb]', view)) {
    const trip = trips.find((t) => t.id === canvas.dataset.thumb);
    if (!trip) continue;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = 58 * dpr;
    canvas.height = 42 * dpr;
    drawThumbnail(canvas, trip.segments || [], { maxSpeedMs: trip.topSpeedMs });
  }

  on(view, 'click', '[data-filter]', (e, el) => {
    app.historyFilter = el.dataset.filter;
    route();
  });
  on(view, 'click', '[data-trip]', (e, el) => {
    location.hash = `#/trip/${el.dataset.trip}`;
  });
}

function tripRow(trip) {
  const s = sys();
  return `<li><button class="row" data-trip="${esc(trip.id)}">
    <canvas class="thumb" data-thumb="${esc(trip.id)}" aria-hidden="true"></canvas>
    <span class="row-main">
      <span class="row-title">${esc(friendlyDay(trip.startedAt))}, ${esc(clockTime(trip.startedAt))}
        ${trip.favorite ? '<span class="star">&#9733;</span>' : ''}</span>
      <span class="row-sub">${formatDistance(trip.distanceM, s)} ${esc(distanceUnitLabel(s))}
        &middot; ${formatDuration(trip.durationS)}${trip.hadGap ? ' &middot; has a gap' : ''}</span>
    </span>
    <span class="row-side">
      <strong>${formatSpeed(trip.topSpeedMs, s)}</strong>
      <span class="row-sub">${esc(speedUnitLabel(s))}</span>
    </span>
  </button></li>`;
}

// --- Trip detail ----------------------------------------------------------

async function tripScreen(view, id) {
  const trip = await store.getTrip(decodeURIComponent(id));
  if (!trip) {
    view.innerHTML = `<div class="empty"><h2>Drive not found</h2>
      <p>It may have been deleted. <a href="#/history">Back to history</a></p></div>`;
    return;
  }
  const s = sys();
  const points = (trip.segments || []).flat();
  const vehicle = findVehicle(app.vehicles, trip.vehicleId);
  const fuel = fuelEstimate(trip.distanceM, vehicle, { system: s, pricePerUnit: app.settings.fuelPrice });

  view.innerHTML = `
    <div class="screen-head">
      <h1>${esc(friendlyDay(trip.startedAt))}</h1>
      <span class="label">${esc(clockTime(trip.startedAt))} &ndash; ${esc(clockTime(trip.endedAt))}</span>
    </div>

    <div class="map tall" id="tripMap"></div>
    <div class="ramp"><span>Slower</span><span class="ramp-bar"></span><span>Faster</span></div>
    ${trip.hadGap ? `<p class="section-note">This route has ${trip.gapCount}
      ${trip.gapCount === 1 ? 'gap' : 'gaps'} where the signal dropped. The map leaves
      them broken rather than drawing a straight line that never happened.</p>` : ''}

    ${statRow([
      { label: 'Distance', value: formatDistance(trip.distanceM, s), unit: distanceUnitLabel(s) },
      { label: 'Top speed', value: formatSpeed(trip.topSpeedMs, s), unit: speedUnitLabel(s) },
      { label: 'Moving average', value: formatSpeed(trip.avgSpeedMs, s), unit: speedUnitLabel(s) },
      { label: 'Total time', value: formatDuration(trip.durationS) },
      { label: 'Moving', value: formatDuration(trip.movingS) },
      { label: 'Stopped', value: formatDuration(trip.stoppedS) },
      { label: 'Climb', value: String(Math.round(shortDistanceIn(trip.elevationGainM || 0, s))), unit: shortDistanceUnitLabel(s) },
      { label: 'Peak g', value: formatG(trip.peakG || 0) },
      { label: 'Smoothness', value: String(trip.score ?? '--') },
    ])}

    ${vehicle || fuel ? `<p class="section-note">
      ${vehicle ? esc(vehicleLabel(vehicle)) : ''}${vehicle && fuel ? ' &middot; ' : ''}
      ${fuel ? `about ${fuel.amount.toFixed(2)} ${esc(fuel.unit)} of fuel, ${esc(formatMoney(fuel.cost))}` : ''}
    </p>` : ''}

    <div class="section">
      <h2>Speed</h2>
      <canvas class="chart" id="speedChart"></canvas>
    </div>

    ${points.some((p) => Number.isFinite(p.alt)) ? `
      <div class="section">
        <h2>Elevation</h2>
        <canvas class="chart" id="altChart" style="height:110px"></canvas>
      </div>` : ''}

    <div class="section">
      <h2>Replay</h2>
      <input type="range" id="scrub" min="0" max="${Math.max(0, points.length - 1)}" value="0"
             aria-label="Scrub through the drive" style="width:100%">
      <dl class="kv" style="margin-top:10px">
        <dt>Time</dt><dd id="scrubTime">--</dd>
        <dt>Speed</dt><dd id="scrubSpeed">--</dd>
      </dl>
    </div>

    ${performanceSection(trip)}

    <div class="section">
      <h2>Notes</h2>
      <div class="field">
        <textarea id="note" placeholder="Where did you go?">${esc(trip.note || '')}</textarea>
        <p class="field-hint">Saved on this device only.</p>
      </div>
    </div>

    <div class="section">
      <h2>Share and export</h2>
      <div class="btn-row">
        <button class="btn btn-primary btn-small" data-act="share">Share card</button>
        <button class="btn btn-small" data-act="fav">${trip.favorite ? 'Unfavourite' : 'Favourite'}</button>
      </div>
      <div class="btn-row">
        <button class="btn btn-small" data-act="gpx">GPX</button>
        <button class="btn btn-small" data-act="geojson">GeoJSON</button>
        <button class="btn btn-small" data-act="csv">CSV</button>
      </div>
      <div class="btn-row">
        <button class="btn btn-small btn-danger" data-act="delete">Delete this drive</button>
      </div>
    </div>
  `;

  // Map
  const mapHost = $('#tripMap');
  if (window.L && points.length > 1) {
    const map = createMap(mapHost, { style: app.settings.mapStyle });
    drawRoute(map, trip.segments, { maxSpeedMs: trip.topSpeedMs });
    fitRoute(map, trip.segments);
    startMarker(map, points[0].lat, points[0].lon);
    app.tripMap = map;
    setTimeout(() => map.invalidateSize(), 60);
  } else {
    mapHost.innerHTML = `<div class="map-note">${points.length > 1
      ? 'Map tiles need a connection. The route is still recorded.'
      : 'Not enough points to draw a route.'}</div>`;
  }

  // Charts
  const chartPoints = points.map((p) => ({ t: p.t, speed: p.speed }));
  if (chartPoints.length > 1) {
    speedChart($('#speedChart'), chartPoints, { convert: (v) => speedIn(v, s) });
  }
  const alts = points.filter((p) => Number.isFinite(p.alt)).map((p) => p.alt);
  if ($('#altChart') && alts.length > 1) lineChart($('#altChart'), alts, { height: 110 });

  // Replay scrubber
  const scrub = $('#scrub');
  const applyScrub = () => {
    const p = points[Number(scrub.value)];
    if (!p) return;
    $('#scrubTime').textContent = clockTime(p.t);
    $('#scrubSpeed').textContent = `${formatSpeed(p.speed, s)} ${speedUnitLabel(s)}`;
    if (app.tripMap) setPosition(app.tripMap, p.lat, p.lon, { follow: false });
  };
  scrub?.addEventListener('input', applyScrub);
  if (points.length) applyScrub();

  // Actions
  $('#note')?.addEventListener('change', async (e) => {
    await store.putTrip({ ...trip, note: e.target.value });
    toast('Note saved.');
  });
  on(view, 'click', '[data-act="fav"]', async () => {
    await store.putTrip({ ...trip, favorite: !trip.favorite });
    route();
  });
  on(view, 'click', '[data-act="share"]', () => openShareSheet(trip));
  on(view, 'click', '[data-act="gpx"]', () => {
    download(`drivecrew-${trip.id}.gpx`, toGPX(trip), 'application/gpx+xml');
  });
  on(view, 'click', '[data-act="geojson"]', () => {
    download(`drivecrew-${trip.id}.geojson`, toGeoJSON(trip), 'application/geo+json');
  });
  on(view, 'click', '[data-act="csv"]', () => {
    download(`drivecrew-${trip.id}-points.csv`, tripPointsToCSV(trip), 'text/csv');
  });
  on(view, 'click', '[data-act="delete"]', async () => {
    const ok = await confirmSheet({
      title: 'Delete this drive?',
      body: 'This cannot be undone. A summary already shared with a crew stays there.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await store.deleteTrip(trip.id);
    toast('Drive deleted.');
    location.hash = '#/history';
  });
}

function formatMoney(amount) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: app.settings.currency || 'USD' })
      .format(amount);
  } catch {
    return amount.toFixed(2);
  }
}

function performanceSection(trip) {
  const perf = trip.performance;
  if (!perf) return '';
  const s = sys();
  const metric = s === 'metric';

  // Both unit systems are always measured so records survive a unit switch,
  // but only the ones matching the chosen system are worth showing.
  const entryMs = metric ? kmhToMs(100) : mphToMs(60);
  const accel = (perf.accel || []).filter((a) =>
    metric ? [27.7778, 55.5556].some((v) => Math.abs(a.toMs - v) < 0.1)
           : [13.4112, 26.8224, 44.704].some((v) => Math.abs(a.toMs - v) < 0.1));
  const rollon = (perf.rollon || []).filter((r) => Math.abs(r.fromMs - entryMs) < 0.1);
  const drag = perf.drag || [];
  const braking = (perf.braking || []).filter((b) => Math.abs(b.fromMs - entryMs) < 0.1);

  const anything = accel.length || rollon.length || drag.length || braking.length || perf.peakPowerHp;
  if (!anything) return '';

  if (!app.settings.trackMode) {
    return `<div class="section">
      <h2>Performance timing</h2>
      <p class="section-note">This drive has timing data. Turn on performance
        timing in Settings to see it. These figures are for closed courses.</p>
    </div>`;
  }

  const rows = [
    ...accel.map((a) => [accelLabel(a.toMs, s), `${a.timeS.toFixed(2)} s`]),
    ...rollon.map((a) => [
      `${Math.round(speedIn(a.fromMs, s))}–${Math.round(speedIn(a.toMs, s))} ${speedUnitLabel(s)}`,
      `${a.timeS.toFixed(2)} s`,
    ]),
    ...drag.map((d) => [
      Math.abs(d.distanceM - 402.336) < 1 ? 'Quarter mile' : Math.abs(d.distanceM - 201.168) < 1 ? 'Eighth mile' : `${Math.round(d.distanceM)} m`,
      `${d.timeS.toFixed(2)} s at ${formatSpeed(d.trapSpeedMs, s)} ${speedUnitLabel(s)}`,
    ]),
    ...braking.map((b) => [
      `${Math.round(speedIn(b.fromMs, s))}–0 ${speedUnitLabel(s)}`,
      `${Math.round(shortDistanceIn(b.distanceM, s))} ${shortDistanceUnitLabel(s)} in ${b.timeS.toFixed(2)} s`,
    ]),
  ];
  if (perf.peakPowerHp) rows.push(['Estimated peak power', `${formatHp(perf.peakPowerHp)} hp`]);
  if (perf.peakLateralG) rows.push(['Peak lateral', formatG(perf.peakLateralG)]);

  return `<div class="section">
    <h2>Performance timing</h2>
    <dl class="kv" style="margin-top:10px">
      ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
    </dl>
    <p class="section-note">Timed from GPS, so treat these as repeatable rather
      than exact: about a fifth of a second either way. Keep this kind of driving
      to a closed course.</p>
  </div>`;
}

function openShareSheet(trip) {
  const vehicle = findVehicle(app.vehicles, trip.vehicleId);
  openSheet(
    `<h2>Share this drive</h2>
     <canvas class="share-preview" id="sharePreview"></canvas>
     <div class="segmented" style="margin-top:14px">
       <button data-size="post" aria-pressed="true">Square-ish</button>
       <button data-size="story" aria-pressed="false">Story</button>
     </div>
     <p class="field-hint">Only what you see here is shared. No map tiles, no
       coordinates, no address.</p>
     <div class="btn-row">
       <button class="btn" data-close>Close</button>
       <button class="btn btn-primary" data-act="send">Share or save</button>
     </div>`,
    {
      onMount(panel) {
        let size = 'post';
        const preview = $('#sharePreview', panel);

        const paint = () => {
          const card = renderShareCard(trip, { size, system: sys(), vehicleName: vehicleLabel(vehicle) });
          preview.width = card.width;
          preview.height = card.height;
          preview.getContext('2d').drawImage(card, 0, 0);
        };
        paint();

        on(panel, 'click', '[data-size]', (e, el) => {
          size = el.dataset.size;
          for (const b of $$('[data-size]', panel)) b.setAttribute('aria-pressed', String(b === el));
          paint();
        });
        on(panel, 'click', '[data-act="send"]', async () => {
          try {
            const how = await shareCard(trip, { size, system: sys(), vehicleName: vehicleLabel(vehicle) });
            if (how === 'downloaded') toast('Card saved to your downloads.');
          } catch (err) {
            toast('Could not create the card.');
            console.warn(err);
          }
        });
      },
    }
  );
}

// --- Records, trends, awards ---------------------------------------------

async function recordsScreen(view) {
  const trips = await store.allTrips();
  const r = computeRecords(trips);
  const s = sys();

  if (!trips.length) {
    view.innerHTML = `<div class="screen-head"><h1>Records</h1></div>
      <div class="empty"><h2>Nothing to beat yet</h2><p>Records appear after your first drive.</p></div>`;
    return;
  }

  const recordRow = (label, record, formatValue) =>
    record
      ? `<li><button class="row" data-trip="${esc(record.tripId)}">
          <span class="row-main">
            <span class="row-title">${esc(label)}</span>
            <span class="row-sub">${esc(friendlyDay(record.at))}</span>
          </span>
          <span class="row-side"><strong>${formatValue(record.value)}</strong></span>
        </button></li>`
      : '';

  const perfRows = app.settings.trackMode
    ? [
        ...r.accel
          .filter((a) => s === 'metric'
            ? [27.7778, 55.5556].some((v) => Math.abs(a.toMs - v) < 0.1)
            : [13.4112, 26.8224, 44.704].some((v) => Math.abs(a.toMs - v) < 0.1))
          .map((a) => recordRow(accelLabel(a.toMs, s), { tripId: a.tripId, at: a.at, value: a.timeS }, (v) => `${v.toFixed(2)} s`)),
        ...r.drag.map((d) => recordRow(
          Math.abs(d.distanceM - 402.336) < 1 ? 'Quarter mile' : 'Eighth mile',
          { tripId: d.tripId, at: d.at, value: d.timeS }, (v) => `${v.toFixed(2)} s`)),
        ...r.braking.map((b) => recordRow(
          `${Math.round(speedIn(b.fromMs, s))}–0 ${speedUnitLabel(s)}`,
          { tripId: b.tripId, at: b.at, value: b.distanceM },
          (v) => `${Math.round(shortDistanceIn(v, s))} ${shortDistanceUnitLabel(s)}`)),
      ].join('')
    : '';

  view.innerHTML = `
    <div class="screen-head"><h1>Records</h1></div>

    <div class="section">
      <h2>Bests</h2>
      <ul class="list">
        ${recordRow('Top speed', r.topSpeed, (v) => `${formatSpeed(v, s)} ${speedUnitLabel(s)}`)}
        ${recordRow('Longest drive', r.longestDistance, (v) => `${formatDistance(v, s)} ${distanceUnitLabel(s)}`)}
        ${recordRow('Longest time at the wheel', r.longestDuration, (v) => formatDuration(v))}
        ${recordRow('Most climbing', r.highestClimb, (v) => `${Math.round(shortDistanceIn(v, s))} ${shortDistanceUnitLabel(s)}`)}
        ${recordRow('Highest g', r.peakG, (v) => formatG(v))}
        ${recordRow('Smoothest drive', r.bestScore, (v) => String(v))}
      </ul>
    </div>

    ${r.bestWeek ? `<div class="section">
      <h2>Busiest week</h2>
      <p class="section-note">${formatDistance(r.bestWeek.distanceM, s)} ${esc(distanceUnitLabel(s))}
        over ${r.bestWeek.tripCount} ${r.bestWeek.tripCount === 1 ? 'drive' : 'drives'},
        starting ${esc(fullDate(r.bestWeek.from))}.</p>
    </div>` : ''}

    ${perfRows ? `<div class="section">
      <h2>Closed-course bests</h2>
      <ul class="list">${perfRows}</ul>
    </div>` : ''}

    <div class="section">
      <h2>All time</h2>
      ${statRow([
        { label: 'Drives', value: String(r.totals.trips) },
        { label: 'Distance', value: formatDistance(r.totals.distanceM, s), unit: distanceUnitLabel(s) },
        { label: 'Time driving', value: formatDurationLong(r.totals.movingS) },
      ])}
    </div>
  `;

  on(view, 'click', '[data-trip]', (e, el) => {
    location.hash = `#/trip/${el.dataset.trip}`;
  });
}

async function statsScreen(view) {
  const trips = await store.allTrips();
  const s = sys();
  if (!trips.length) {
    view.innerHTML = `<div class="screen-head"><h1>Trends</h1></div>
      <div class="empty"><h2>Nothing to chart yet</h2><p>Trends appear once you have a few drives.</p></div>`;
    return;
  }

  const period = app.statsPeriod || 'week';
  const groups = groupByPeriod(trips, period).slice(-12);
  const thisPeriod = periodStart(Date.now(), period);

  view.innerHTML = `
    <div class="screen-head"><h1>Trends</h1></div>

    <div class="segmented">
      <button data-period="week" aria-pressed="${period === 'week'}">By week</button>
      <button data-period="month" aria-pressed="${period === 'month'}">By month</button>
    </div>

    <div class="section">
      <h2>Distance</h2>
      <canvas class="chart" id="distBars"></canvas>
      <p class="section-note">The last ${groups.length} ${period === 'week' ? 'weeks' : 'months'},
        in ${esc(distanceUnitLabel(s))}.</p>
    </div>

    <div class="section">
      <h2>Smoothness</h2>
      <canvas class="chart" id="scoreLine" style="height:110px"></canvas>
      <p class="section-note">Your smoothness score over your last
        ${Math.min(trips.length, 30)} drives. Higher means fewer harsh
        accelerations, hard stops and sharp turns.</p>
    </div>

    <div class="section">
      <h2>Where the time goes</h2>
      ${statRow([
        { label: 'Moving', value: formatDurationLong(summarize(trips).movingS) },
        { label: 'Stopped', value: formatDurationLong(trips.reduce((a, t) => a + (t.stoppedS || 0), 0)) },
        { label: 'Drives with a gap', value: String(trips.filter((t) => t.hadGap).length) },
      ])}
    </div>
  `;

  barChart($('#distBars'), groups.map((g) => ({
    value: distanceIn(g.distanceM, s),
    label: period === 'week'
      ? new Date(g.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      : new Date(g.start).toLocaleDateString(undefined, { month: 'short' }),
    highlight: g.start === thisPeriod,
  })));

  const scores = trips.slice(0, 30).reverse().map((t) => t.score ?? 0);
  if (scores.length > 1) lineChart($('#scoreLine'), scores, { height: 110 });

  on(view, 'click', '[data-period]', (e, el) => {
    app.statsPeriod = el.dataset.period;
    route();
  });
}

async function awardsScreen(view) {
  const trips = await store.allTrips();
  const list = evaluateAchievements({ trips });
  const earned = list.filter((a) => a.earned).length;

  const groups = [...new Set(list.map((a) => a.group))];

  view.innerHTML = `
    <div class="screen-head">
      <h1>Awards</h1>
      <span class="label num">${earned} of ${list.length}</span>
    </div>
    <p class="section-note" style="margin-bottom:18px">None of these reward speed.
      They are about distance, climbing, consistency and driving smoothly.</p>
    ${groups.map((group) => `
      <div class="section">
        <h2>${esc(group)}</h2>
        <div class="awards">
          ${list.filter((a) => a.group === group).map(awardCard).join('')}
        </div>
      </div>`).join('')}
  `;
}

function awardCard(a) {
  return `<div class="award ${a.earned ? 'earned' : ''}">
    <span class="award-mark">${a.earned ? '&#10003;' : '&middot;'}</span>
    <span style="flex:1;min-width:0">
      <span class="award-name">${esc(a.name)}</span>
      <span class="faint" style="display:block">${esc(a.description)}</span>
      ${a.earned
        ? `<span class="faint">Earned ${esc(friendlyDay(a.earnedAt))}</span>`
        : `<span class="meter"><i style="width:${Math.round(a.progress * 100)}%"></i></span>`}
    </span>
  </div>`;
}

// --- Crew -----------------------------------------------------------------

const AVATARS = ['\u{1F697}', '\u{1F3CE}\u{FE0F}', '\u{1F699}', '\u{1F6FB}', '\u{1F690}', '\u{1F3C1}', '\u{26A1}', '\u{1F527}', '\u{1F319}', '\u{1F525}', '\u{1F340}', '\u{1F3D4}\u{FE0F}'];

function crewNotConfigured(view) {
  view.innerHTML = `
    <div class="screen-head"><h1>Crew</h1></div>
    <div class="banner">
      <h3>Crews are not set up yet</h3>
      <p>Everything else in DriveCrew works without an account. Crews need a
        free Firebase project, which takes about ten minutes to create once.</p>
      <p class="faint">Follow "Setting up crews" in README.md, paste the config
        into firebase-config.js, and this screen turns into a leaderboard.</p>
    </div>
    <div class="empty">
      <h2>Nothing is missing from your drives</h2>
      <p>Your history, records, awards and share cards are all local and all
        complete. Crews only add a shared leaderboard.</p>
    </div>`;
}

async function crewScreen(view) {
  if (!(await crew.isConfigured())) return crewNotConfigured(view);

  view.innerHTML = `<div class="screen-head"><h1>Crew</h1></div><p class="muted">Connecting…</p>`;
  const conn = await crew.connect();
  if (!conn.ok) {
    view.innerHTML = `
      <div class="screen-head"><h1>Crew</h1></div>
      <div class="banner danger">
        <h3>Could not connect</h3>
        <p>${esc(conn.message || 'Check the Firebase config and that anonymous sign-in is enabled.')}</p>
      </div>`;
    return;
  }
  app.crewReady = true;

  if (!app.profile || !app.profile.name) return crewProfileSetup(view);

  app.crews = await crew.crewsFromProfile((app.profile && app.profile.crews) || []);
  await persistCrewIds(app.crews.map((c) => c.id));

  view.innerHTML = `
    <div class="screen-head">
      <h1>Crew</h1>
      <button class="btn btn-small" data-act="edit-profile">${esc(app.profile.avatar)} ${esc(app.profile.name)}</button>
    </div>

    ${app.crews.length === 0 ? `
      <div class="empty">
        <h2>No crews yet</h2>
        <p>Make one and send the code to your friends, or join theirs.</p>
      </div>` : `
      <ul class="list">
        ${app.crews.map((c) => `<li><button class="row" data-crew="${esc(c.id)}">
          <span class="avatar">${esc(c.name.slice(0, 1).toUpperCase())}</span>
          <span class="row-main">
            <span class="row-title">${esc(c.name)}</span>
            <span class="row-sub">Code ${esc(c.code)}</span>
          </span>
          <span class="row-side faint">View</span>
        </button></li>`).join('')}
      </ul>`}

    <div class="section">
      <div class="btn-row">
        <button class="btn btn-primary btn-small" data-act="create">Create a crew</button>
        <button class="btn btn-small" data-act="join">Join with a code</button>
      </div>
    </div>

    <p class="section-note">Only summary figures are shared: distance,
      time, top speed, peak g. Your route never leaves this device. Leaderboard
      numbers come from each person's own phone, so treat it as a friendly
      scoreboard. Keep performance driving to a closed course.</p>
  `;

  on(view, 'click', '[data-crew]', (e, el) => {
    location.hash = `#/crew/${el.dataset.crew}`;
  });
  on(view, 'click', '[data-act="create"]', () => createCrewSheet());
  on(view, 'click', '[data-act="join"]', () => joinCrewSheet());
  on(view, 'click', '[data-act="edit-profile"]', () => crewProfileSetup(view));
}

async function persistCrewIds(ids) {
  app.profile = { ...(app.profile || {}), crews: ids };
  await store.kvSet('profile', app.profile).catch(() => {});
}

function crewProfileSetup(view) {
  const current = app.profile || { name: app.settings.displayName || '', avatar: AVATARS[0] };
  view.innerHTML = `
    <div class="screen-head"><h1>Your name</h1></div>
    <p class="muted">This is what your friends see on the leaderboard. No email,
      no password, no phone number.</p>
    <div class="field">
      <label for="cname">Display name</label>
      <input type="text" id="cname" maxlength="24" value="${esc(current.name)}" placeholder="Sam">
    </div>
    <div class="field">
      <label>Avatar</label>
      <div class="scroll-x" id="avatars">
        ${AVATARS.map((a) => `<button class="chip" data-avatar="${a}"
          aria-pressed="${a === current.avatar}" style="font-size:1.15rem">${a}</button>`).join('')}
      </div>
    </div>
    <button class="btn btn-primary" data-act="save-profile">Save</button>
  `;

  let avatar = current.avatar || AVATARS[0];
  on(view, 'click', '[data-avatar]', (e, el) => {
    avatar = el.dataset.avatar;
    for (const b of $$('[data-avatar]', view)) b.setAttribute('aria-pressed', String(b === el));
  });
  on(view, 'click', '[data-act="save-profile"]', async () => {
    const name = $('#cname').value.trim();
    if (!name) {
      toast('Pick a name first.');
      return;
    }
    await crew.saveProfile({ name, avatar });
    app.profile = { ...(app.profile || {}), name, avatar };
    await store.kvSet('profile', app.profile).catch(() => {});
    await saveSettings({ displayName: name });
    toast('Saved.');
    location.hash = '#/crew';
    route();
  });
}

function createCrewSheet() {
  openSheet(
    `<h2>Create a crew</h2>
     <div class="field">
       <label for="crewName">Crew name</label>
       <input type="text" id="crewName" maxlength="40" placeholder="Sunday drivers">
     </div>
     <div class="btn-row">
       <button class="btn" data-close>Cancel</button>
       <button class="btn btn-primary" data-act="go">Create</button>
     </div>`,
    {
      onMount(panel, close) {
        on(panel, 'click', '[data-act="go"]', async () => {
          const name = $('#crewName', panel).value.trim();
          if (!name) return toast('Give it a name.');
          try {
            const made = await crew.createCrew({
              name,
              displayName: app.profile.name,
              avatar: app.profile.avatar,
              car: vehicleLabel(activeVehicle()),
            });
            await persistCrewIds([...((app.profile && app.profile.crews) || []), made.id]);
            await crew.rememberCrews(app.profile.crews);
            close();
            showCodeSheet(made);
          } catch (err) {
            toast('Could not create the crew.');
            console.warn(err);
          }
        });
      },
    }
  );
}

function showCodeSheet(made) {
  const link = `${location.origin}${location.pathname}#/join/${made.code}`;
  openSheet(
    `<h2>${esc(made.name)} is ready</h2>
     <p class="muted">Send this code or link to your friends. Anyone with it can join.</p>
     <p class="code num">${esc(made.code)}</p>
     <div class="field">
       <label for="joinLink">Invite link</label>
       <input type="text" id="joinLink" readonly value="${esc(link)}">
     </div>
     <div class="btn-row">
       <button class="btn" data-act="copy">Copy link</button>
       <button class="btn btn-primary" data-act="done">Done</button>
     </div>`,
    {
      onMount(panel, close) {
        on(panel, 'click', '[data-act="copy"]', async () => {
          try {
            await navigator.clipboard.writeText(link);
            toast('Link copied.');
          } catch {
            $('#joinLink', panel).select();
            toast('Press and hold to copy.');
          }
        });
        on(panel, 'click', '[data-act="done"]', () => {
          close();
          route();
        });
      },
    }
  );
}

function joinCrewSheet(prefill = '') {
  openSheet(
    `<h2>Join a crew</h2>
     <div class="field">
       <label for="joinCode">Invite code</label>
       <input type="text" id="joinCode" maxlength="7" autocapitalize="characters"
              autocomplete="off" value="${esc(prefill)}" placeholder="ABC234">
       <p class="field-hint">Six characters, from whoever made the crew.</p>
     </div>
     <div class="btn-row">
       <button class="btn" data-close>Cancel</button>
       <button class="btn btn-primary" data-act="go">Join</button>
     </div>`,
    {
      onMount(panel, close) {
        on(panel, 'click', '[data-act="go"]', async () => {
          const result = await crew.joinByCode({
            code: $('#joinCode', panel).value,
            displayName: app.profile.name,
            avatar: app.profile.avatar,
            car: vehicleLabel(activeVehicle()),
          });
          if (!result.ok) {
            toast(result.reason === 'bad-code' ? 'That code is not six characters.' : 'No crew with that code.');
            return;
          }
          await persistCrewIds([...new Set([...((app.profile && app.profile.crews) || []), result.crew.id])]);
          await crew.rememberCrews(app.profile.crews);
          close();
          toast(`Joined ${result.crew.name}.`);
          location.hash = `#/crew/${result.crew.id}`;
          route();
        });
      },
    }
  );
}

async function joinScreen(view, code) {
  const clean = crew.normaliseCode(code);
  if (!(await crew.isConfigured())) return crewNotConfigured(view);

  view.innerHTML = `<div class="screen-head"><h1>Join a crew</h1></div><p class="muted">Connecting…</p>`;
  const conn = await crew.connect();
  if (!conn.ok) {
    view.innerHTML = `<div class="banner danger"><h3>Could not connect</h3>
      <p>${esc(conn.message || 'Try again in a moment.')}</p></div>`;
    return;
  }
  if (!app.profile || !app.profile.name) {
    app.pendingJoinCode = clean;
    return crewProfileSetup(view);
  }
  view.innerHTML = `
    <div class="screen-head"><h1>Join a crew</h1></div>
    <p class="muted">You were invited with the code below.</p>
    <p class="code num">${esc(clean)}</p>
    <button class="btn btn-primary" data-act="join">Join this crew</button>
    <div class="btn-row"><a class="btn" href="#/crew">Not now</a></div>`;

  on(view, 'click', '[data-act="join"]', () => joinCrewSheet(clean));
}

const WINDOWS = {
  week: { name: 'This week', since: () => periodStart(Date.now(), 'week') },
  month: { name: 'This month', since: () => periodStart(Date.now(), 'month') },
  all: { name: 'All time', since: () => 0 },
};

async function crewDetailScreen(view, crewId) {
  if (!(await crew.isConfigured())) return crewNotConfigured(view);
  const conn = await crew.connect();
  if (!conn.ok) {
    view.innerHTML = `<div class="banner danger"><h3>Could not connect</h3></div>`;
    return;
  }

  const found = app.crews.find((c) => c.id === crewId)
    || (await crew.crewsFromProfile([crewId])).find((c) => c.id === crewId);
  if (!found) {
    view.innerHTML = `<div class="empty"><h2>Crew not found</h2>
      <p>You may have left it. <a href="#/crew">Back to crews</a></p></div>`;
    return;
  }

  const board = app.crewBoard || 'topSpeed';
  const windowKey = app.crewWindow || 'week';
  const s = sys();

  view.innerHTML = `
    <div class="screen-head"><h1>${esc(found.name)}</h1>
      <span class="label">Code ${esc(found.code)}</span></div>
    <p class="muted">Loading the leaderboard…</p>`;

  const [rows, members] = await Promise.all([
    crew.leaderboard(crewId, { since: WINDOWS[windowKey].since() }),
    crew.crewMembers(crewId),
  ]);

  const boards = {
    topSpeed: { name: 'Top speed', get: (r) => r.topSpeedMs, fmt: (v) => `${formatSpeed(v, s)} ${speedUnitLabel(s)}`, desc: true },
    distanceM: { name: 'Distance', get: (r) => r.distanceM, fmt: (v) => `${formatDistance(v, s)} ${distanceUnitLabel(s)}`, desc: true },
    trips: { name: 'Drives', get: (r) => r.trips, fmt: (v) => String(v), desc: true },
    score: { name: 'Smoothness', get: (r) => r.score ?? 0, fmt: (v) => String(v), desc: true },
  };
  if (app.settings.trackMode) {
    boards.bestAccelS = {
      name: `0–${Math.round(speedIn(mphToMs(60), s))}`,
      get: (r) => r.bestAccelS,
      fmt: (v) => `${v.toFixed(2)} s`,
      desc: false,
    };
  }

  const spec = boards[board] || boards.topSpeed;
  const ranked = rows
    .filter((r) => Number.isFinite(spec.get(r)))
    .sort((a, b) => (spec.desc ? spec.get(b) - spec.get(a) : spec.get(a) - spec.get(b)));

  const me = crew.currentUid();
  const isOwner = found.ownerUid === me;

  view.innerHTML = `
    <div class="screen-head"><h1>${esc(found.name)}</h1>
      <span class="label">Code ${esc(found.code)}</span></div>

    <div class="scroll-x">
      ${Object.entries(boards).map(([key, b]) =>
        `<button class="chip" data-board="${key}" aria-pressed="${key === board}">${esc(b.name)}</button>`).join('')}
    </div>

    <div class="segmented" style="margin-top:12px">
      ${Object.entries(WINDOWS).map(([key, w]) =>
        `<button data-window="${key}" aria-pressed="${key === windowKey}">${esc(w.name)}</button>`).join('')}
    </div>

    <div class="section">
      ${ranked.length === 0 ? `
        <div class="empty"><h2>Nothing shared yet</h2>
          <p>Summaries appear here after someone finishes a drive in this window.</p></div>` : `
        <ul class="list">
          ${ranked.map((r, i) => `<li class="row ${r.uid === me ? 'is-me' : ''}">
            <span class="lb-rank num">${i + 1}</span>
            <span class="avatar">${esc((members.find((m) => m.uid === r.uid) || {}).avatar || '\u{1F697}')}</span>
            <span class="row-main">
              <span class="row-title">${esc(r.name || 'Someone')}</span>
              ${r.car ? `<span class="row-sub">${esc(r.car)}</span>` : ''}
            </span>
            <span class="row-side"><strong>${esc(spec.fmt(spec.get(r)))}</strong></span>
          </li>`).join('')}
        </ul>`}
    </div>

    <div class="section">
      <h2>Members</h2>
      <ul class="list">
        ${members.map((m) => `<li class="row">
          <span class="avatar">${esc(m.avatar || '\u{1F697}')}</span>
          <span class="row-main">
            <span class="row-title">${esc(m.name || 'Someone')}${m.uid === found.ownerUid ? ' <span class="faint">owner</span>' : ''}</span>
            ${m.car ? `<span class="row-sub">${esc(m.car)}</span>` : ''}
          </span>
          ${isOwner && m.uid !== me
            ? `<button class="btn btn-small btn-danger" data-remove="${esc(m.uid)}">Remove</button>`
            : ''}
        </li>`).join('')}
      </ul>
    </div>

    <div class="section">
      <div class="btn-row">
        <button class="btn btn-small" data-act="invite">Show invite code</button>
        ${isOwner
          ? `<button class="btn btn-small btn-danger" data-act="delete">Delete crew</button>`
          : `<button class="btn btn-small btn-danger" data-act="leave">Leave crew</button>`}
      </div>
    </div>
  `;

  on(view, 'click', '[data-board]', (e, el) => { app.crewBoard = el.dataset.board; route(); });
  on(view, 'click', '[data-window]', (e, el) => { app.crewWindow = el.dataset.window; route(); });
  on(view, 'click', '[data-act="invite"]', () => showCodeSheet(found));
  on(view, 'click', '[data-remove]', async (e, el) => {
    const ok = await confirmSheet({ title: 'Remove this member?', body: 'They can rejoin with the code.', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    await crew.removeMember(crewId, el.dataset.remove);
    route();
  });
  on(view, 'click', '[data-act="leave"]', async () => {
    const ok = await confirmSheet({ title: `Leave ${found.name}?`, body: 'Summaries you already shared stay on the leaderboard.', confirmLabel: 'Leave', danger: true });
    if (!ok) return;
    await crew.leaveCrew(crewId);
    await persistCrewIds(((app.profile && app.profile.crews) || []).filter((id) => id !== crewId));
    await crew.rememberCrews(app.profile.crews);
    location.hash = '#/crew';
  });
  on(view, 'click', '[data-act="delete"]', async () => {
    const ok = await confirmSheet({ title: `Delete ${found.name}?`, body: 'The leaderboard goes with it. This cannot be undone.', confirmLabel: 'Delete crew', danger: true });
    if (!ok) return;
    await crew.deleteCrew(crewId, found.code);
    await persistCrewIds(((app.profile && app.profile.crews) || []).filter((id) => id !== crewId));
    location.hash = '#/crew';
  });
}

// --- Settings -------------------------------------------------------------

function toggleRow(key, title, hint) {
  return `<div class="toggle">
    <span class="toggle-text"><span>${esc(title)}</span><span class="faint">${hint}</span></span>
    <label class="switch">
      <input type="checkbox" data-toggle="${esc(key)}" ${app.settings[key] ? 'checked' : ''}
             aria-label="${esc(title)}">
      <span></span>
    </label>
  </div>`;
}

async function settingsScreen(view) {
  const s = sys();
  const usage = await store.estimateUsage();
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

  view.innerHTML = `
    <div class="screen-head"><h1>Settings</h1></div>

    <div class="section">
      <h2>Units</h2>
      <div class="segmented" style="margin-top:10px">
        <button data-system="imperial" aria-pressed="${s === 'imperial'}">mph and miles</button>
        <button data-system="metric" aria-pressed="${s === 'metric'}">km/h and km</button>
      </div>
    </div>

    <div class="section">
      <h2>Your car</h2>
      <div class="field" style="margin-top:10px">
        <label for="vehPick">Recording with</label>
        <select id="vehPick">
          <option value="">No car selected</option>
          ${app.vehicles.map((v) => `<option value="${esc(v.id)}"
            ${v.id === app.settings.activeVehicleId ? 'selected' : ''}>${esc(vehicleLabel(v))}</option>`).join('')}
        </select>
        <p class="field-hint">Shown on share cards and the crew leaderboard.</p>
      </div>
      <a class="btn btn-small" href="#/garage">Open the garage</a>
    </div>

    <div class="section">
      <h2>Recording</h2>
      ${toggleRow('autoArm', 'Start watching when the app opens', 'Only once you have allowed location.')}
      ${toggleRow('wakeLock', 'Keep the screen awake while driving', 'Tracking stops when the screen sleeps.')}
      ${toggleRow('motion', 'Measure g-force', 'Uses the phone&rsquo;s motion sensors. Approximate.')}
      ${toggleRow('trackMode', 'Show performance timing', '0&ndash;60, quarter mile, braking. For closed courses.')}
    </div>

    <div class="section">
      <h2>Detection</h2>
      <div class="field" style="margin-top:10px">
        <label for="startSpeed">Speed that counts as driving (${esc(speedUnitLabel(s))})</label>
        <input type="number" id="startSpeed" min="1" max="40" step="1"
               value="${Math.round(speedIn(app.settings.START_SPEED_MS, s))}">
        <p class="field-hint">Below this, DriveCrew assumes you are not driving yet.</p>
      </div>
      <div class="field">
        <label for="stopMins">End a drive after stopping for (minutes)</label>
        <input type="number" id="stopMins" min="1" max="30" step="1"
               value="${Math.round(app.settings.END_STOP_S / 60)}">
      </div>
      <div class="field">
        <label for="accLimit">Ignore fixes less accurate than (metres)</label>
        <input type="number" id="accLimit" min="5" max="200" step="5" value="${app.settings.MAX_ACC_M}">
        <p class="field-hint">Raise this if drives fail to start in built-up areas.</p>
      </div>
    </div>

    <div class="section">
      <h2>Crews</h2>
      ${toggleRow('shareWithCrews', 'Share finished drives with my crews', 'Summary figures only. Never your route.')}
      <div class="field" style="margin-top:12px">
        <label for="shareMode">What to share</label>
        <select id="shareMode">
          <option value="full" ${app.settings.shareMode !== 'speed-only' ? 'selected' : ''}>Distance, time, top speed, peak g</option>
          <option value="speed-only" ${app.settings.shareMode === 'speed-only' ? 'selected' : ''}>Top speed only</option>
        </select>
      </div>
    </div>

    <div class="section">
      <h2>Appearance</h2>
      <div class="segmented" style="margin-top:10px">
        <button data-theme="dark" aria-pressed="${app.settings.theme === 'dark'}">Dark</button>
        <button data-theme="light" aria-pressed="${app.settings.theme === 'light'}">Light</button>
        <button data-theme="auto" aria-pressed="${app.settings.theme === 'auto'}">Match system</button>
      </div>
      <div class="segmented" style="margin-top:10px">
        ${Object.entries(MAP_STYLES).map(([key, m]) =>
          `<button data-mapstyle="${key}" aria-pressed="${app.settings.mapStyle === key}">${esc(m.name)}</button>`).join('')}
      </div>
    </div>

    <div class="section">
      <h2>Costs</h2>
      <div class="field" style="margin-top:10px">
        <label for="fuelPrice">Fuel price per ${s === 'metric' ? 'litre' : 'gallon'}</label>
        <input type="number" id="fuelPrice" min="0" max="20" step="0.01" value="${app.settings.fuelPrice}">
        <p class="field-hint">Used with each car&rsquo;s economy to estimate what a drive cost.</p>
      </div>
    </div>

    <div class="section">
      <h2>Install</h2>
      ${standalone
        ? `<p class="section-note">DriveCrew is installed. Nice.</p>`
        : app.installEvent
          ? `<button class="btn btn-primary btn-small" data-act="install">Add to home screen</button>`
          : `<p class="section-note">On iPhone: tap the Share button in Safari, then
             <strong>Add to Home Screen</strong>. On Android: open the browser menu and
             choose <strong>Install app</strong>. Installing gives it a full screen and
             its own icon.</p>`}
      <div class="btn-row"><a class="btn btn-small" href="#/help">Open automatically in the car</a></div>
    </div>

    <div class="section">
      <h2>Your data</h2>
      <p class="section-note">Everything is stored on this device. There is no
        account, no analytics and no advertising.
        ${usage && usage.usage ? `About ${(usage.usage / 1_048_576).toFixed(1)} MB used.` : ''}</p>
      <div class="btn-row">
        <button class="btn btn-small" data-act="export-json">Export everything</button>
        <button class="btn btn-small" data-act="export-csv">Export CSV</button>
      </div>
      <div class="btn-row">
        <button class="btn btn-small" data-act="import">Import a backup</button>
        <button class="btn btn-small btn-danger" data-act="wipe">Delete all data</button>
      </div>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </div>

    <div class="section">
      <h2>Safety</h2>
      <div class="banner">${safetyCopy()}</div>
    </div>

    <div class="section">
      ${toggleRow('developer', 'Developer tools', 'Replay a simulated drive through the real pipeline.')}
      <div id="devTools"></div>
    </div>

    <div class="section">
      <div class="btn-row">
        <a class="btn btn-small" href="#/about">About and limitations</a>
      </div>
    </div>
  `;

  renderDevTools();

  on(view, 'click', '[data-system]', async (e, el) => {
    await saveSettings({ system: el.dataset.system });
    route();
  });
  on(view, 'click', '[data-theme]', async (e, el) => {
    await saveSettings({ theme: el.dataset.theme });
    document.documentElement.dataset.theme = el.dataset.theme;
    route();
  });
  on(view, 'click', '[data-mapstyle]', async (e, el) => {
    await saveSettings({ mapStyle: el.dataset.mapstyle });
    route();
  });

  on(view, 'change', '[data-toggle]', async (e, el) => {
    const key = el.dataset.toggle;
    const value = el.checked;

    if (key === 'trackMode' && value && !app.settings.trackModeAck) {
      const ok = await confirmSheet({
        title: 'Performance timing',
        body: `<p>These figures are for a closed course. Public roads have speed
          limits and other people on them.</p><p>DriveCrew will never prompt you
          to drive faster, and no award here is given for speed.</p>`,
        confirmLabel: 'I understand',
      });
      if (!ok) {
        el.checked = false;
        return;
      }
      await saveSettings({ trackModeAck: true });
    }

    await saveSettings({ [key]: value });
    if (key === 'developer') renderDevTools();
    if (key === 'wakeLock') value ? app.wake.request() : app.wake.release();
  });

  $('#vehPick')?.addEventListener('change', async (e) => {
    await saveSettings({ activeVehicleId: e.target.value || null });
    toast('Car updated.');
  });
  $('#shareMode')?.addEventListener('change', (e) => saveSettings({ shareMode: e.target.value }));
  $('#fuelPrice')?.addEventListener('change', (e) =>
    saveSettings({ fuelPrice: Number(e.target.value) || 0 }));
  $('#startSpeed')?.addEventListener('change', (e) => {
    const typed = Number(e.target.value);
    const ms = s === 'metric' ? kmhToMs(typed) : mphToMs(typed);
    saveSettings({ START_SPEED_MS: Math.max(1, Math.min(18, ms)) });
  });
  $('#stopMins')?.addEventListener('change', (e) =>
    saveSettings({ END_STOP_S: Math.max(60, Math.min(1800, Number(e.target.value) * 60)) }));
  $('#accLimit')?.addEventListener('change', (e) =>
    saveSettings({ MAX_ACC_M: Math.max(5, Math.min(200, Number(e.target.value))) }));

  on(view, 'click', '[data-act="install"]', async () => {
    app.installEvent.prompt();
    app.installEvent = null;
    route();
  });
  on(view, 'click', '[data-act="export-json"]', async () => {
    const data = await store.exportAll();
    download(`drivecrew-backup-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(data, null, 2), 'application/json');
  });
  on(view, 'click', '[data-act="export-csv"]', async () => {
    const trips = await store.allTrips();
    download(`drivecrew-drives-${new Date().toISOString().slice(0, 10)}.csv`,
      tripsToCSV(trips, s), 'text/csv');
  });
  on(view, 'click', '[data-act="import"]', () => $('#importFile').click());
  $('#importFile')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const result = await store.importAll(JSON.parse(await file.text()));
      app.vehicles = await listVehicles();
      app.settings = { ...SETTINGS_DEFAULTS, ...(await store.loadSettings()) };
      toast(`Imported ${result.added} drives, skipped ${result.skipped} already here.`);
      route();
    } catch (err) {
      toast('That file is not a DriveCrew backup.');
      console.warn(err);
    }
  });
  on(view, 'click', '[data-act="wipe"]', async () => {
    const ok = await confirmSheet({
      title: 'Delete everything?',
      body: 'Every drive, car and setting on this device. Export a backup first if you might want it. This cannot be undone.',
      confirmLabel: 'Delete everything',
      danger: true,
    });
    if (!ok) return;
    await store.deleteEverything();
    app.settings = { ...SETTINGS_DEFAULTS };
    app.vehicles = [];
    app.profile = null;
    toast('All data deleted.');
    location.hash = '#/drive';
    route();
  });
}

function renderDevTools() {
  const host = $('#devTools');
  if (!host) return;
  if (!app.settings.developer) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = `
    <p class="section-note">A simulated drive feeds a synthetic track through the
      same engine, filters and screens a real drive uses. Timestamps keep their
      real one-second spacing, so the 6-second start confirmation and the
      ${Math.round(app.settings.END_STOP_S / 60)}-minute auto-stop behave exactly as they would on the road.</p>
    ${Object.entries(TRACKS).map(([key, t]) => `
      <div class="toggle">
        <span class="toggle-text"><span>${esc(t.name)}</span><span class="faint">${esc(t.note)}</span></span>
      </div>
      <div class="scroll-x" style="margin:6px 0 14px">
        ${[1, 10, 60].map((rate) =>
          `<button class="chip" data-sim="${key}" data-rate="${rate}">${rate}&times;</button>`).join('')}
      </div>`).join('')}
  `;

  on(host, 'click', '[data-sim]', async (e, el) => {
    const track = TRACKS[el.dataset.sim].build();
    if (app.armed) disarm();
    await arm({ simTrack: track, rate: Number(el.dataset.rate) });
    location.hash = '#/drive';
    route();
    toast(`Replaying ${TRACKS[el.dataset.sim].name} at ${el.dataset.rate}x.`);
  });
}

// --- Garage ---------------------------------------------------------------

async function garageScreen(view) {
  app.vehicles = await listVehicles();
  const trips = await store.allTrips();

  view.innerHTML = `
    <div class="screen-head"><h1>Garage</h1></div>
    <p class="muted">Add a car to label your drives. A kerb weight also lets
      DriveCrew estimate power on a closed-course pull.</p>

    ${app.vehicles.length === 0 ? `
      <div class="empty"><h2>No cars yet</h2><p>Add one to get started.</p></div>` : `
      <ul class="list">
        ${app.vehicles.map((v) => {
          const mine = trips.filter((t) => t.vehicleId === v.id);
          const totals = summarize(mine);
          return `<li><button class="row" data-vehicle="${esc(v.id)}">
            <span class="avatar" style="background:${esc(v.colour)}1A;border-color:${esc(v.colour)}">&#9679;</span>
            <span class="row-main">
              <span class="row-title">${esc(vehicleLabel(v))}</span>
              <span class="row-sub">${totals.trips} ${totals.trips === 1 ? 'drive' : 'drives'}
                &middot; ${formatDistance(totals.distanceM, sys())} ${esc(distanceUnitLabel(sys()))}</span>
            </span>
            <span class="row-side faint">Edit</span>
          </button></li>`;
        }).join('')}
      </ul>`}

    <div class="section">
      <button class="btn btn-primary btn-small" data-act="add">Add a car</button>
    </div>`;

  on(view, 'click', '[data-vehicle]', (e, el) => {
    location.hash = `#/vehicle/${el.dataset.vehicle}`;
  });
  on(view, 'click', '[data-act="add"]', async () => {
    const v = newVehicle();
    await saveVehicle(v);
    app.vehicles = await listVehicles();
    location.hash = `#/vehicle/${v.id}`;
  });
}

async function vehicleScreen(view, id) {
  app.vehicles = await listVehicles();
  const v = findVehicle(app.vehicles, decodeURIComponent(id));
  if (!v) {
    view.innerHTML = `<div class="empty"><h2>Car not found</h2>
      <p><a href="#/garage">Back to the garage</a></p></div>`;
    return;
  }
  const s = sys();

  view.innerHTML = `
    <div class="screen-head"><h1>${esc(vehicleLabel(v))}</h1></div>

    <div class="field">
      <label for="vName">Name</label>
      <input type="text" id="vName" maxlength="30" value="${esc(v.name)}" placeholder="The GTI">
    </div>
    <div class="field">
      <label for="vMakeModel">Make and model</label>
      <input type="text" id="vMakeModel" maxlength="40" value="${esc(v.makeModel)}" placeholder="Volkswagen Golf GTI">
    </div>
    <div class="field">
      <label for="vYear">Year</label>
      <input type="text" id="vYear" maxlength="4" inputmode="numeric" value="${esc(v.year)}" placeholder="2018">
    </div>
    <div class="field">
      <label for="vMass">Kerb weight with you in it (kg)</label>
      <input type="number" id="vMass" min="300" max="5000" step="10" value="${v.massKg ?? ''}" placeholder="1480">
      <p class="field-hint">Needed for the estimated power figure. Leave it blank to skip that.</p>
    </div>
    <div class="field">
      <label for="vEcon">Fuel economy (${s === 'metric' ? 'L/100km' : 'mpg'})</label>
      <input type="number" id="vEcon" min="1" max="200" step="0.1" value="${v.economy ?? ''}" placeholder="${s === 'metric' ? '7.5' : '32'}">
    </div>
    <div class="field">
      <label for="vColour">Colour</label>
      <input type="text" id="vColour" maxlength="7" value="${esc(v.colour)}" placeholder="#FFB020">
    </div>

    <div class="btn-row">
      <button class="btn btn-primary" data-act="save">Save</button>
    </div>
    <div class="btn-row">
      <button class="btn btn-small" data-act="use">Record with this car</button>
      <button class="btn btn-small btn-danger" data-act="delete">Delete</button>
    </div>`;

  on(view, 'click', '[data-act="save"]', async () => {
    await saveVehicle({
      ...v,
      name: $('#vName').value.trim(),
      makeModel: $('#vMakeModel').value.trim(),
      year: $('#vYear').value.trim(),
      massKg: Number($('#vMass').value) || null,
      economy: Number($('#vEcon').value) || null,
      colour: $('#vColour').value.trim() || '#FFB020',
    });
    app.vehicles = await listVehicles();
    toast('Car saved.');
    location.hash = '#/garage';
  });
  on(view, 'click', '[data-act="use"]', async () => {
    await saveSettings({ activeVehicleId: v.id });
    toast(`Recording with ${vehicleLabel(v)}.`);
  });
  on(view, 'click', '[data-act="delete"]', async () => {
    const ok = await confirmSheet({
      title: 'Delete this car?',
      body: 'Drives recorded with it are kept, but lose the label.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await removeVehicle(v.id);
    if (app.settings.activeVehicleId === v.id) await saveSettings({ activeVehicleId: null });
    app.vehicles = await listVehicles();
    location.hash = '#/garage';
  });
}

// --- Help and about -------------------------------------------------------

async function helpScreen(view) {
  const url = `${location.origin}${location.pathname}`;
  view.innerHTML = `
    <div class="screen-head"><h1>Open in the car</h1></div>
    <p class="muted">A browser app cannot launch itself when you get in the car.
      You can set that up once on your phone, though, and after that DriveCrew
      opens on its own and starts recording when you move.</p>

    <div class="field">
      <label for="appUrl">This app&rsquo;s address</label>
      <input type="text" id="appUrl" readonly value="${esc(url)}">
      <p class="field-hint">You need this in the steps below.</p>
    </div>
    <button class="btn btn-small" data-act="copy">Copy the address</button>

    <div class="section">
      <h2>iPhone</h2>
      <ol class="muted" style="padding-left:1.2em">
        <li>Open the <strong>Shortcuts</strong> app.</li>
        <li>Go to the <strong>Automation</strong> tab and tap <strong>+</strong>.</li>
        <li>Choose <strong>CarPlay</strong> if your car has it, or
          <strong>Bluetooth</strong> and pick your car&rsquo;s stereo.</li>
        <li>Set it to <strong>Connects</strong>, and choose <strong>Run Immediately</strong>.</li>
        <li>Add the <strong>Open URL</strong> action and paste the address above.</li>
      </ol>
    </div>

    <div class="section">
      <h2>Android</h2>
      <ol class="muted" style="padding-left:1.2em">
        <li>Open the Google app, then <strong>Routines</strong>
          (in Assistant settings).</li>
        <li>Create a routine with the starter <strong>Bluetooth device
          connects</strong> and pick your car.</li>
        <li>Add the action to open a web page and paste the address above.</li>
      </ol>
      <p class="section-note">Tasker does the same thing with more control:
        a profile on your car&rsquo;s Bluetooth, with a Browse URL action.</p>
    </div>

    <div class="section">
      <h2>What this does and does not do</h2>
      <p class="muted">Once DriveCrew is open on screen it detects movement and
        starts the drive itself. It still cannot record with the screen off or
        while another app is in front, so leave it open in a mount.</p>
    </div>`;

  on(view, 'click', '[data-act="copy"]', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Address copied.');
    } catch {
      $('#appUrl').select();
      toast('Press and hold to copy.');
    }
  });
}

async function aboutScreen(view) {
  const configured = await crew.isConfigured();
  view.innerHTML = `
    <div class="screen-head"><h1>About</h1>
      <span class="label num">v${esc(APP_VERSION)}</span></div>

    <p class="muted">${esc(APP_NAME)} is a free drive tracker. No subscription,
      no paid tier, no adverts, no analytics. Every feature is available to
      everyone, which is rather the point.</p>

    <div class="section">
      <h2>What it cannot do</h2>
      <p class="muted">This is a web app, so the operating system suspends it
        when the screen goes off or you switch away. While suspended it receives
        no location updates at all, which means:</p>
      <ul class="muted" style="padding-left:1.2em">
        <li>It <strong>cannot</strong> record in the background. The app has to be
          open with the screen on.</li>
        <li>It <strong>cannot</strong> launch itself when you get in the car, though
          <a href="#/help">a one-time automation</a> can open it for you.</li>
        <li>Breaks longer than ${DEFAULTS.GAP_S} seconds are marked as gaps. The app
          never invents a straight line across missing data.</li>
      </ul>
      <p class="muted">True background recording needs a native app, which needs
        paid developer accounts. The code is organised so that is a small change
        rather than a rewrite; see docs/PHASE2-CAPACITOR.md.</p>
    </div>

    <div class="section">
      <h2>Your privacy</h2>
      <p class="muted">Drives, routes and settings are stored on this device in
        IndexedDB and are never uploaded. ${configured
          ? 'Because crews are set up, finished drives send a summary (distance, time, top speed, peak g) to your crews. Your route is never sent.'
          : 'Crews are not set up, so nothing leaves this device at all.'}</p>
      <p class="muted">Map tiles are fetched from OpenStreetMap and CARTO as you
        pan, which tells them which tiles you asked for. The route itself is
        drawn locally.</p>
    </div>

    <div class="section">
      <h2>Accuracy</h2>
      <p class="muted">Speed comes from the GPS receiver where it offers one and
        from position changes where it does not. One-off spikes are rejected, and
        a top speed only counts when two consecutive readings agree within 15%.
        G-force and estimated power are approximate: a phone in a mount measures
        its own vibration too, and the power figure assumes a weight and a drag
        coefficient rather than measuring them.</p>
    </div>

    <div class="section">
      <h2>Credits</h2>
      <p class="muted">Maps with <a href="https://leafletjs.com">Leaflet</a>.
        Map data &copy; OpenStreetMap contributors. Tiles by CARTO and
        OpenTopoMap. An original app, not affiliated with any other drive tracker.</p>
    </div>`;
}

// --- go -------------------------------------------------------------------

boot();
