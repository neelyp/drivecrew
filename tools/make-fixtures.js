// Writes the simulator tracks out as JSON fixtures for the unit tests.
// Run with: node tools/make-fixtures.js
import { writeFileSync, mkdirSync } from 'node:fs';
import { cityLoop, highwayRun, launchDemo } from '../js/sim.js';

const targets = ['tests/fixtures'];
const tracks = {
  'city-loop': cityLoop(),
  'highway-run': highwayRun(),
  'launch-demo': launchDemo(),
};

for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  for (const [name, track] of Object.entries(tracks)) {
    writeFileSync(`${dir}/${name}.json`, JSON.stringify(track), 'utf8');
    console.log(`${dir}/${name}.json  ${track.length} samples`);
  }
}
