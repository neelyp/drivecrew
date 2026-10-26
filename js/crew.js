// Crews: anonymous accounts, invite codes, and a shared leaderboard.
//
// Two hard rules in here:
//  1. Only trip SUMMARIES are ever uploaded. No GPS points, no coordinates,
//     nothing about where anybody went. See summaryFor().
//  2. If firebase-config.js still holds placeholders, every function in here
//     returns a "not configured" result and the rest of the app carries on.
//
// The Firebase SDK is imported dynamically, so a local-only install never
// fetches it at all.

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

// Unambiguous alphabet: no O/0, no I/1, nothing you can mishear down the pub.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const LEADERBOARD_TRIP_CAP = 500;

let state = {
  configured: null,
  app: null,
  auth: null,
  db: null,
  fns: null,
  uid: null,
  profile: null,
  error: null,
};

export function generateCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function normaliseCode(input) {
  // The alphabet deliberately excludes I, L, O, 0 and 1, so any of those in a
  // typed code is a typo. Drop everything that is not a real code character and
  // let the length check reject what is left.
  return String(input || '')
    .toUpperCase()
    .split('')
    .filter((ch) => CODE_ALPHABET.includes(ch))
    .join('')
    .slice(0, CODE_LENGTH);
}

/** Is a real Firebase project configured? */
export async function isConfigured() {
  if (state.configured !== null) return state.configured;
  try {
    const mod = await import('../firebase-config.js');
    const cfg = mod.firebaseConfig || {};
    const looksPlaceholder =
      !cfg.apiKey ||
      cfg.apiKey.startsWith('YOUR_') ||
      !cfg.projectId ||
      cfg.projectId.startsWith('YOUR_');
    state.configured = !looksPlaceholder;
    state.rawConfig = cfg;
  } catch {
    state.configured = false;
  }
  return state.configured;
}

/** Sign in anonymously and cache the SDK handles. Safe to call repeatedly. */
export async function connect() {
  if (!(await isConfigured())) return { ok: false, reason: 'not-configured' };
  if (state.uid) return { ok: true, uid: state.uid };

  try {
    const [appMod, authMod, dbMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);

    state.app = appMod.initializeApp(state.rawConfig);
    state.auth = authMod.getAuth(state.app);
    state.db = dbMod.getFirestore(state.app);
    state.fns = { ...dbMod };

    const cred = await authMod.signInAnonymously(state.auth);
    state.uid = cred.user.uid;
    return { ok: true, uid: state.uid };
  } catch (err) {
    state.error = err;
    return { ok: false, reason: 'connect-failed', message: err.message };
  }
}

export const currentUid = () => state.uid;

function requireDb() {
  if (!state.db) throw new Error('Crews are not connected');
  return { db: state.db, f: state.fns };
}

// --- profile --------------------------------------------------------------

export async function saveProfile({ name, avatar }) {
  const { db, f } = requireDb();
  state.profile = { name, avatar };
  await f.setDoc(
    f.doc(db, 'users', state.uid),
    { name, avatar, createdAt: f.serverTimestamp() },
    { merge: true }
  );
  return state.profile;
}

export async function loadProfile() {
  const { db, f } = requireDb();
  const snap = await f.getDoc(f.doc(db, 'users', state.uid));
  state.profile = snap.exists() ? snap.data() : null;
  return state.profile;
}

// --- crews ----------------------------------------------------------------

export async function createCrew({ name, displayName, avatar, car = '' }) {
  const { db, f } = requireDb();
  const code = generateCode();
  const crewRef = f.doc(f.collection(db, 'crews'));

  await f.setDoc(crewRef, {
    name,
    code,
    ownerUid: state.uid,
    createdAt: f.serverTimestamp(),
    memberCount: 1,
  });
  // The code document is the join lookup: anyone signed in can read it.
  await f.setDoc(f.doc(db, 'codes', code), { crewId: crewRef.id, ownerUid: state.uid });
  await f.setDoc(f.doc(db, 'crews', crewRef.id, 'members', state.uid), {
    name: displayName,
    avatar,
    car,
    joinedAt: f.serverTimestamp(),
    shareEnabled: true,
  });

  return { id: crewRef.id, name, code };
}

export async function joinByCode({ code, displayName, avatar, car = '' }) {
  const { db, f } = requireDb();
  const clean = normaliseCode(code);
  if (clean.length !== CODE_LENGTH) return { ok: false, reason: 'bad-code' };

  const codeSnap = await f.getDoc(f.doc(db, 'codes', clean));
  if (!codeSnap.exists()) return { ok: false, reason: 'not-found' };

  const { crewId } = codeSnap.data();
  await f.setDoc(f.doc(db, 'crews', crewId, 'members', state.uid), {
    name: displayName,
    avatar,
    car,
    joinedAt: f.serverTimestamp(),
    shareEnabled: true,
  });

  const crewSnap = await f.getDoc(f.doc(db, 'crews', crewId));
  return { ok: true, crew: { id: crewId, ...(crewSnap.data() || {}) } };
}

/** Crew membership is kept on the user document, so no collection-group query is needed. */
export async function rememberCrews(ids) {
  const { db, f } = requireDb();
  await f.setDoc(f.doc(db, 'users', state.uid), { crews: ids }, { merge: true });
}

export async function crewsFromProfile(localIds = []) {
  const { db, f } = requireDb();
  const ids = new Set(localIds);
  try {
    const snap = await f.getDoc(f.doc(db, 'users', state.uid));
    for (const id of (snap.exists() && snap.data().crews) || []) ids.add(id);
  } catch {
    /* fall back to the local list */
  }
  const crews = [];
  for (const id of ids) {
    try {
      const snap = await f.getDoc(f.doc(db, 'crews', id));
      if (snap.exists()) crews.push({ id, ...snap.data() });
    } catch {
      /* no longer a member, or the crew is gone */
    }
  }
  return crews;
}

export async function crewMembers(crewId) {
  const { db, f } = requireDb();
  const snap = await f.getDocs(f.collection(db, 'crews', crewId, 'members'));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

export async function leaveCrew(crewId) {
  const { db, f } = requireDb();
  await f.deleteDoc(f.doc(db, 'crews', crewId, 'members', state.uid));
}

export async function removeMember(crewId, uid) {
  const { db, f } = requireDb();
  await f.deleteDoc(f.doc(db, 'crews', crewId, 'members', uid));
}

export async function deleteCrew(crewId, code) {
  const { db, f } = requireDb();
  if (code) await f.deleteDoc(f.doc(db, 'codes', code)).catch(() => {});
  await f.deleteDoc(f.doc(db, 'crews', crewId));
}

// --- trip sharing ---------------------------------------------------------

/**
 * The ONLY shape that ever leaves the device. Summary figures, no coordinates,
 * no route, no start or end place. `mode` can trim it further still.
 */
export function summaryFor(trip, { name, car, mode = 'full' }) {
  const base = {
    uid: null, // filled in at upload time
    name,
    car: car || '',
    startedAt: trip.startedAt,
    topSpeedMs: Math.min(130, Math.max(0, trip.topSpeedMs || 0)),
  };
  if (mode === 'speed-only') return base;
  return {
    ...base,
    distanceM: Math.max(0, trip.distanceM || 0),
    durationS: Math.max(0, trip.durationS || 0),
    peakG: Math.max(0, trip.peakG || 0),
    score: trip.score ?? null,
    bestAccelS: bestAccel(trip),
  };
}

function bestAccel(trip) {
  const runs = (trip.performance && trip.performance.accel) || [];
  const sixty = runs.find((r) => Math.abs(r.toMs - 26.8224) < 0.01);
  return sixty ? Number(sixty.timeS.toFixed(2)) : null;
}

export async function uploadSummary(crewId, summary) {
  const { db, f } = requireDb();
  const row = { ...summary, uid: state.uid, createdAt: f.serverTimestamp() };
  await f.addDoc(f.collection(db, 'crews', crewId, 'trips'), row);
}

/**
 * Leaderboard. Trips are fetched for the window and aggregated on the device -
 * a friend group never has enough rows to need anything cleverer.
 */
export async function leaderboard(crewId, { since = 0 } = {}) {
  const { db, f } = requireDb();
  const snap = await f.getDocs(
    f.query(
      f.collection(db, 'crews', crewId, 'trips'),
      f.where('startedAt', '>=', since),
      f.orderBy('startedAt', 'desc'),
      f.limit(LEADERBOARD_TRIP_CAP)
    )
  );

  const byUid = new Map();
  for (const docSnap of snap.docs) {
    const t = docSnap.data();
    const entry =
      byUid.get(t.uid) ||
      { uid: t.uid, name: t.name, car: t.car, topSpeedMs: 0, distanceM: 0, trips: 0, bestAccelS: null, score: null };
    entry.name = t.name || entry.name;
    entry.car = t.car || entry.car;
    entry.topSpeedMs = Math.max(entry.topSpeedMs, t.topSpeedMs || 0);
    entry.distanceM += t.distanceM || 0;
    entry.trips += 1;
    if (Number.isFinite(t.bestAccelS)) {
      entry.bestAccelS = entry.bestAccelS === null ? t.bestAccelS : Math.min(entry.bestAccelS, t.bestAccelS);
    }
    if (Number.isFinite(t.score)) {
      entry.score = entry.score === null ? t.score : Math.round((entry.score + t.score) / 2);
    }
    byUid.set(t.uid, entry);
  }
  return [...byUid.values()];
}

export function connectionError() {
  return state.error;
}
