// Every tunable number in one place. Settings may override anything in DEFAULTS.

export const APP_NAME = 'DriveCrew';
export const APP_VERSION = '1.0.0';
export const APP_TAGLINE = 'Drive tracking, free forever.';

// --- Trip detection (see README "Trip detection") -------------------------
export const DEFAULTS = {
  // Sample filtering
  MAX_ACC_M: 30,          // ignore samples with horizontal accuracy worse than this
  MAX_ACCEL_MS2: 12,      // reject speed jumps implying more acceleration than this
  MAX_SPEED_MS: 130,      // hard sanity cap (~291 mph)
  TOP_SPEED_CONFIRM_RATIO: 0.15, // two consecutive samples must agree within this

  // Start / stop state machine
  START_SPEED_MS: 4.5,    // ~10 mph: counts as driving
  START_CONFIRM_S: 6,     // must hold at or above start speed this long
  STOP_SPEED_MS: 1.0,     // below this counts as stopped
  END_STOP_S: 180,        // stopped this long ends the trip
  GAP_S: 20,              // sample gap longer than this breaks the route
  MIN_TRIP_DIST_M: 300,   // discard shorter trips at end
  MIN_TRIP_S: 60,

  // Route storage: keep a point every POINT_MIN_MS *and* POINT_MIN_M
  POINT_MIN_MS: 1000,
  POINT_MIN_M: 5,

  // Display smoothing (display only - records use unsmoothed values)
  SMOOTH_MEDIAN_WINDOW: 3,
  SMOOTH_EMA_ALPHA: 0.4,

  // Draft persistence
  DRAFT_INTERVAL_MS: 10_000,

  // Performance timing (closed-course features)
  LAUNCH_SPEED_MS: 1.0,         // below this, a standing start is armed
  ACCEL_TARGETS_MPH: [30, 60, 100],
  ACCEL_TARGETS_KMH: [100, 200],
  ROLLON_MPH: [[60, 130]],
  ROLLON_KMH: [[100, 200]],
  DRAG_DISTANCES_M: [201.168, 402.336], // 1/8 and 1/4 mile
  BRAKE_FROM_MPH: 60,
  BRAKE_FROM_KMH: 100,
  PERF_ABORT_RISE_MS: 1.0,      // a braking run is void if speed climbs this much

  // Smoothness scoring thresholds
  HARSH_ACCEL_MS2: 3.0,
  HARSH_BRAKE_MS2: 3.5,
  HARSH_CORNER_G: 0.40,

  // Estimated power model
  DRIVETRAIN_EFFICIENCY: 0.85,
  AIR_DENSITY: 1.225,
  DEFAULT_MASS_KG: 1500,
  DEFAULT_CDA: 0.65,
  DEFAULT_CRR: 0.012,
  GRAVITY: 9.80665,
};

// User-facing settings and their defaults.
export const SETTINGS_DEFAULTS = {
  system: 'imperial',        // 'imperial' | 'metric'
  displayName: '',
  activeVehicleId: null,
  wakeLock: true,
  motion: true,              // g-force sensing
  autoArm: true,             // start watching GPS on app open once permitted
  trackMode: false,          // show closed-course performance timing
  trackModeAck: false,       // user acknowledged the closed-course notice
  shareWithCrews: true,
  developer: false,
  safetySeen: false,
  shareMode: 'full',       // 'full' | 'speed-only'
  currency: 'USD',
  theme: 'dark',
  mapStyle: 'dark',
  fuelPrice: 3.50,           // per gallon (imperial) or litre (metric)
  START_SPEED_MS: DEFAULTS.START_SPEED_MS,
  END_STOP_S: DEFAULTS.END_STOP_S,
  MAX_ACC_M: DEFAULTS.MAX_ACC_M,
};

/** Merge user settings over DEFAULTS to get the engine config. */
export function resolveConfig(settings = {}) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (settings[key] !== undefined && settings[key] !== null) out[key] = settings[key];
  }
  return out;
}
