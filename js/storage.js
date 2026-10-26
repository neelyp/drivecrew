// IndexedDB wrapper, hand-rolled so there is no dependency to keep alive.
// Everything the app records lives here, on the device, and nowhere else.

const DB_NAME = 'drivecrew';
const DB_VERSION = 1;

const STORES = {
  trips: { keyPath: 'id', indexes: [['startedAt', 'startedAt']] },
  vehicles: { keyPath: 'id' },
  kv: { keyPath: 'key' },           // settings, draft, profile, cached records
  pendingUploads: { keyPath: 'id' }, // crew summaries waiting for a network
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, spec] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: spec.keyPath });
        for (const [idxName, idxKey] of spec.indexes || []) store.createIndex(idxName, idxKey);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        transaction.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

const wrap = (req) => ({ __req: req });

// --- trips ----------------------------------------------------------------
export const putTrip = (trip) => tx('trips', 'readwrite', (s) => wrap(s.put(trip)));
export const getTrip = (id) => tx('trips', 'readonly', (s) => wrap(s.get(id)));
export const deleteTrip = (id) => tx('trips', 'readwrite', (s) => wrap(s.delete(id)));

/** Newest first. `limit` caps the result; `since` filters by start time. */
export function allTrips({ limit = Infinity, since = 0 } = {}) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction('trips', 'readonly');
        const index = transaction.objectStore('trips').index('startedAt');
        const out = [];
        const cursorReq = index.openCursor(null, 'prev');
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || out.length >= limit) {
            resolve(out);
            return;
          }
          if (cursor.value.startedAt >= since) out.push(cursor.value);
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      })
  );
}

export const countTrips = () => tx('trips', 'readonly', (s) => wrap(s.count()));

// --- key/value ------------------------------------------------------------
export const kvGet = (key) =>
  tx('kv', 'readonly', (s) => wrap(s.get(key))).then((row) => (row ? row.value : null));
export const kvSet = (key, value) => tx('kv', 'readwrite', (s) => wrap(s.put({ key, value })));
export const kvDelete = (key) => tx('kv', 'readwrite', (s) => wrap(s.delete(key)));

export const saveDraft = (draft) => kvSet('draft', draft);
export const loadDraft = () => kvGet('draft');
export const clearDraft = () => kvDelete('draft');

export const loadSettings = () => kvGet('settings');
export const saveSettings = (settings) => kvSet('settings', settings);

// --- vehicles -------------------------------------------------------------
export const putVehicle = (v) => tx('vehicles', 'readwrite', (s) => wrap(s.put(v)));
export const deleteVehicle = (id) => tx('vehicles', 'readwrite', (s) => wrap(s.delete(id)));
export const allVehicles = () => tx('vehicles', 'readonly', (s) => wrap(s.getAll()));

// --- pending crew uploads -------------------------------------------------
export const queueUpload = (row) => tx('pendingUploads', 'readwrite', (s) => wrap(s.put(row)));
export const allUploads = () => tx('pendingUploads', 'readonly', (s) => wrap(s.getAll()));
export const removeUpload = (id) => tx('pendingUploads', 'readwrite', (s) => wrap(s.delete(id)));

// --- backup ---------------------------------------------------------------
export async function exportAll() {
  const [trips, vehicles, settings, profile] = await Promise.all([
    allTrips(),
    allVehicles(),
    loadSettings(),
    kvGet('profile'),
  ]);
  return {
    app: 'DriveCrew',
    schema: 1,
    exportedAt: new Date().toISOString(),
    trips,
    vehicles,
    settings,
    profile,
  };
}

/** Merge an export back in. Trips with an existing id are left alone. */
export async function importAll(data, { replace = false } = {}) {
  if (!data || data.app !== 'DriveCrew') throw new Error('Not a DriveCrew backup file');
  if (replace) await deleteEverything();
  let added = 0;
  let skipped = 0;
  for (const trip of data.trips || []) {
    const existing = await getTrip(trip.id);
    if (existing) {
      skipped++;
      continue;
    }
    await putTrip(trip);
    added++;
  }
  for (const v of data.vehicles || []) await putVehicle(v);
  if (data.settings) await saveSettings(data.settings);
  if (data.profile) await kvSet('profile', data.profile);
  return { added, skipped };
}

export async function deleteEverything() {
  await tx('trips', 'readwrite', (s) => wrap(s.clear()));
  await tx('vehicles', 'readwrite', (s) => wrap(s.clear()));
  await tx('kv', 'readwrite', (s) => wrap(s.clear()));
  await tx('pendingUploads', 'readwrite', (s) => wrap(s.clear()));
}

export async function estimateUsage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
