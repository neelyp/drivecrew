import test from 'node:test';
import assert from 'node:assert/strict';
import { toGPX, toGeoJSON, tripsToCSV, tripPointsToCSV } from '../js/exporters.js';
import { makeTrip } from './helpers.js';

test('GPX output is a well-formed single-track document', () => {
  const gpx = toGPX(makeTrip());
  assert.ok(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(gpx.includes('<gpx '), 'missing gpx root');
  assert.ok(gpx.includes('creator="DriveCrew"'));
  assert.equal((gpx.match(/<trk>/g) || []).length, 1);
  assert.ok(gpx.trimEnd().endsWith('</gpx>'));
});

test('GPX writes one track segment per route segment', () => {
  const trip = makeTrip({
    segments: [
      [{ t: 1, lat: 40, lon: -74, speed: 10, alt: 5 }],
      [{ t: 2, lat: 41, lon: -75, speed: 11, alt: 6 }],
      [{ t: 3, lat: 42, lon: -76, speed: 12, alt: 7 }],
    ],
  });
  const gpx = toGPX(trip);
  assert.equal((gpx.match(/<trkseg>/g) || []).length, 3);
  assert.equal((gpx.match(/<trkpt /g) || []).length, 3);
});

test('GPX track points carry coordinates, elevation and time', () => {
  const gpx = toGPX(makeTrip());
  assert.ok(gpx.includes('lat="40"'), 'latitude attribute');
  assert.ok(gpx.includes('lon="-74"'), 'longitude attribute');
  assert.ok(gpx.includes('<ele>10</ele>'));
  assert.ok(gpx.includes('<time>2023-11-14T22:13:20.000Z</time>'));
});

test('GPX escapes characters that would break the XML', () => {
  const gpx = toGPX(makeTrip({ note: 'Dave & "Bob" <trip>' }));
  assert.ok(gpx.includes('Dave &amp; &quot;Bob&quot; &lt;trip&gt;'));
  assert.ok(!gpx.includes('<trip>'));
});

test('GPX omits elevation when the device gave none', () => {
  const trip = makeTrip({ segments: [[{ t: 1, lat: 40, lon: -74, speed: 10, alt: null }]] });
  const gpx = toGPX(trip);
  assert.ok(!gpx.includes('<ele>'));
});

test('GeoJSON is a FeatureCollection with a LineString per segment', () => {
  const trip = makeTrip({
    segments: [
      [{ t: 1, lat: 40, lon: -74, speed: 10 }, { t: 2, lat: 40.1, lon: -74, speed: 11 }],
      [{ t: 3, lat: 41, lon: -75, speed: 12 }, { t: 4, lat: 41.1, lon: -75, speed: 13 }],
    ],
  });
  const gj = JSON.parse(toGeoJSON(trip));
  assert.equal(gj.type, 'FeatureCollection');
  assert.equal(gj.features.length, 2);
  assert.equal(gj.features[0].geometry.type, 'LineString');
});

test('GeoJSON coordinates are longitude first', () => {
  const gj = JSON.parse(toGeoJSON(makeTrip()));
  const [lon, lat] = gj.features[0].geometry.coordinates[0];
  assert.equal(lon, -74);
  assert.equal(lat, 40);
});

test('GeoJSON carries the trip summary as properties', () => {
  const gj = JSON.parse(toGeoJSON(makeTrip({ distanceM: 12_345 })));
  assert.equal(gj.properties.distanceM, 12_345);
  assert.ok(gj.properties.startedAt);
});

test('trip CSV has a header and one row per trip', () => {
  const csv = tripsToCSV([makeTrip({ id: 'a' }), makeTrip({ id: 'b' })], 'imperial');
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('id,'));
  assert.ok(lines[1].startsWith('a,'));
});

test('trip CSV quotes fields containing commas and quotes', () => {
  const csv = tripsToCSV([makeTrip({ note: 'to Dave\'s, then home' })], 'imperial');
  assert.ok(csv.includes('"to Dave\'s, then home"'), csv);
  const csv2 = tripsToCSV([makeTrip({ note: 'say "hi"' })], 'imperial');
  assert.ok(csv2.includes('"say ""hi"""'), csv2);
});

test('trip CSV reports distance and speed in the chosen system', () => {
  const trip = makeTrip({ distanceM: 1609.344, topSpeedMs: 26.8224 });
  const imperial = tripsToCSV([trip], 'imperial').trim().split('\n')[1];
  const metric = tripsToCSV([trip], 'metric').trim().split('\n')[1];
  assert.ok(imperial.includes('1.00'), imperial);
  assert.ok(imperial.includes('60.0'), imperial);
  assert.ok(metric.includes('1.61'), metric);
  assert.ok(metric.includes('96.6'), metric);
});

test('point CSV has a header and one row per sample', () => {
  const csv = tripPointsToCSV(makeTrip());
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.ok(lines[0].includes('lat'));
  assert.ok(lines[0].includes('segment'));
  assert.ok(lines[1].includes('40'));
});

test('an empty trip list still produces a header row', () => {
  const csv = tripsToCSV([], 'imperial');
  assert.equal(csv.trim().split('\n').length, 1);
});
