// Security rules tests, run against the Firestore emulator.
//   npm run test:rules
//
// These are kept out of tests/ because they need the emulator; `node --test
// tests/` must stay dependency-free.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, deleteDoc, addDoc, collection, getDocs,
} from 'firebase/firestore';

let env;
const OWNER = 'owner-uid';
const MEMBER = 'member-uid';
const STRANGER = 'stranger-uid';
const CREW = 'crew1';
const CODE = 'ABC234';

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-drivecrew',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8085,
    },
  });
});

after(async () => {
  await env?.cleanup();
});

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'crews', CREW), {
      name: 'Sunday drivers', code: CODE, ownerUid: OWNER, memberCount: 2,
    });
    await setDoc(doc(db, 'codes', CODE), { crewId: CREW, ownerUid: OWNER });
    await setDoc(doc(db, 'crews', CREW, 'members', OWNER), { name: 'Owner', avatar: 'A' });
    await setDoc(doc(db, 'crews', CREW, 'members', MEMBER), { name: 'Member', avatar: 'B' });
    await setDoc(doc(db, 'crews', CREW, 'trips', 'existing'), {
      uid: MEMBER, name: 'Member', startedAt: 1, topSpeedMs: 30,
    });
  });
}

const as = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

const goodTrip = (uid) => ({
  uid, name: 'Member', startedAt: Date.now(), topSpeedMs: 30,
  distanceM: 12000, durationS: 900, peakG: 0.6,
});

test('a signed-out visitor can read nothing', async () => {
  await seed();
  await assertFails(getDoc(doc(anon(), 'crews', CREW)));
  await assertFails(getDoc(doc(anon(), 'codes', CODE)));
  await assertFails(getDoc(doc(anon(), 'users', OWNER)));
});

test('a stranger cannot read a crew they are not in', async () => {
  await seed();
  await assertFails(getDoc(doc(as(STRANGER), 'crews', CREW)));
});

test('a member can read their crew', async () => {
  await seed();
  await assertSucceeds(getDoc(doc(as(MEMBER), 'crews', CREW)));
});

test('a stranger cannot read the member list', async () => {
  await seed();
  await assertFails(getDocs(collection(as(STRANGER), 'crews', CREW, 'members')));
});

test('a member can read the member list', async () => {
  await seed();
  await assertSucceeds(getDocs(collection(as(MEMBER), 'crews', CREW, 'members')));
});

test('a crew can only be created with yourself as owner', async () => {
  await seed();
  const db = as(STRANGER);
  await assertSucceeds(setDoc(doc(db, 'crews', 'mine'), {
    name: 'Mine', code: 'XYZ789', ownerUid: STRANGER, memberCount: 1,
  }));
  await assertFails(setDoc(doc(db, 'crews', 'theirs'), {
    name: 'Theirs', code: 'XYZ788', ownerUid: OWNER, memberCount: 1,
  }));
});

test('a crew needs a name and a six-character code', async () => {
  await seed();
  const db = as(STRANGER);
  await assertFails(setDoc(doc(db, 'crews', 'noname'), { name: '', code: 'XYZ789', ownerUid: STRANGER }));
  await assertFails(setDoc(doc(db, 'crews', 'shortcode'), { name: 'X', code: 'AB', ownerUid: STRANGER }));
});

test('only the owner can change or delete a crew', async () => {
  await seed();
  await assertFails(deleteDoc(doc(as(MEMBER), 'crews', CREW)));
  await assertSucceeds(deleteDoc(doc(as(OWNER), 'crews', CREW)));
});

test('any signed-in user can resolve an invite code', async () => {
  await seed();
  await assertSucceeds(getDoc(doc(as(STRANGER), 'codes', CODE)));
});

test('a code cannot be minted for a crew you do not own', async () => {
  await seed();
  await assertFails(setDoc(doc(as(STRANGER), 'codes', 'HIJACK'), { crewId: CREW, ownerUid: STRANGER }));
});

test('an invite code cannot be repointed at another crew', async () => {
  await seed();
  await assertFails(setDoc(doc(as(OWNER), 'codes', CODE), { crewId: 'somewhere-else' }));
});

test('joining creates only your own membership', async () => {
  await seed();
  const db = as(STRANGER);
  await assertSucceeds(setDoc(doc(db, 'crews', CREW, 'members', STRANGER), {
    name: 'Stranger', avatar: 'C', car: '', shareEnabled: true,
  }));
  await assertFails(setDoc(doc(db, 'crews', CREW, 'members', 'someone-else'), {
    name: 'Nope', avatar: 'D',
  }));
});

test('you cannot join a crew that does not exist', async () => {
  await seed();
  await assertFails(setDoc(doc(as(STRANGER), 'crews', 'no-such-crew', 'members', STRANGER), {
    name: 'Stranger', avatar: 'C',
  }));
});

test('a member can leave, and the owner can remove anyone', async () => {
  await seed();
  await assertFails(deleteDoc(doc(as(STRANGER), 'crews', CREW, 'members', MEMBER)));
  await assertSucceeds(deleteDoc(doc(as(MEMBER), 'crews', CREW, 'members', MEMBER)));
  await seed();
  await assertSucceeds(deleteDoc(doc(as(OWNER), 'crews', CREW, 'members', MEMBER)));
});

test('a member can share a summary under their own uid', async () => {
  await seed();
  await assertSucceeds(addDoc(collection(as(MEMBER), 'crews', CREW, 'trips'), goodTrip(MEMBER)));
});

test('a summary cannot be posted under someone else uid', async () => {
  await seed();
  await assertFails(addDoc(collection(as(MEMBER), 'crews', CREW, 'trips'), goodTrip(OWNER)));
});

test('a non-member cannot post a summary', async () => {
  await seed();
  await assertFails(addDoc(collection(as(STRANGER), 'crews', CREW, 'trips'), goodTrip(STRANGER)));
});

test('a summary carrying location data is rejected', async () => {
  await seed();
  const db = as(MEMBER);
  await assertFails(addDoc(collection(db, 'crews', CREW, 'trips'), { ...goodTrip(MEMBER), lat: 40.1 }));
  await assertFails(addDoc(collection(db, 'crews', CREW, 'trips'), { ...goodTrip(MEMBER), lon: -74.1 }));
  // Flat, because Firestore refuses nested arrays before rules ever run.
  await assertFails(addDoc(collection(db, 'crews', CREW, 'trips'), {
    ...goodTrip(MEMBER), segments: [{ lat: 1, lon: 2 }],
  }));
  await assertFails(addDoc(collection(db, 'crews', CREW, 'trips'), {
    ...goodTrip(MEMBER), points: [{ lat: 1, lon: 2 }],
  }));
});

test('an impossible top speed is rejected', async () => {
  await seed();
  const db = as(MEMBER);
  await assertFails(addDoc(collection(db, 'crews', CREW, 'trips'), { ...goodTrip(MEMBER), topSpeedMs: 400 }));
  await assertFails(addDoc(collection(db, 'crews', CREW, 'trips'), { ...goodTrip(MEMBER), topSpeedMs: -5 }));
  await assertFails(addDoc(collection(db, 'crews', CREW, 'trips'), { ...goodTrip(MEMBER), topSpeedMs: 'fast' }));
});

test('negative distances and durations are rejected', async () => {
  await seed();
  const db = as(MEMBER);
  await assertFails(addDoc(collection(db, 'crews', CREW, 'trips'), { ...goodTrip(MEMBER), distanceM: -1 }));
  await assertFails(addDoc(collection(db, 'crews', CREW, 'trips'), { ...goodTrip(MEMBER), durationS: -1 }));
});

test('a shared summary cannot be edited afterwards', async () => {
  await seed();
  await assertFails(setDoc(doc(as(MEMBER), 'crews', CREW, 'trips', 'existing'), {
    uid: MEMBER, name: 'Member', startedAt: 1, topSpeedMs: 129,
  }));
});

test('you can delete your own summary, and the owner can delete any', async () => {
  await seed();
  await assertFails(deleteDoc(doc(as(STRANGER), 'crews', CREW, 'trips', 'existing')));
  await assertSucceeds(deleteDoc(doc(as(MEMBER), 'crews', CREW, 'trips', 'existing')));
  await seed();
  await assertSucceeds(deleteDoc(doc(as(OWNER), 'crews', CREW, 'trips', 'existing')));
});

test('a profile can only be written by its owner', async () => {
  await seed();
  await assertSucceeds(setDoc(doc(as(MEMBER), 'users', MEMBER), { name: 'Member', avatar: 'B' }));
  await assertFails(setDoc(doc(as(MEMBER), 'users', OWNER), { name: 'Hijacked' }));
});
