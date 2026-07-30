/* error-beacon.js (issue #202) -- unit tests for the pure reporting
   decision (shouldReport/recordReport/makeState). No DOM, no network:
   these are the exact functions install() calls before ever touching
   fetch/sessionStorage, so they're testable head-on via the module's
   CommonJS export (see the UMD wrapper at the top of error-beacon.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const beacon = require('../error-beacon.js');

test('reports a fresh message', () => {
  const state = beacon.makeState();
  assert.equal(beacon.shouldReport(state, 'boom'), true);
});

test('refuses a falsy/empty message', () => {
  const state = beacon.makeState();
  assert.equal(beacon.shouldReport(state, ''), false);
  assert.equal(beacon.shouldReport(state, null), false);
  assert.equal(beacon.shouldReport(state, undefined), false);
});

test('dedupes an identical message within the same session', () => {
  const state = beacon.makeState();
  assert.equal(beacon.shouldReport(state, 'boom'), true);
  beacon.recordReport(state, 'boom');
  assert.equal(beacon.shouldReport(state, 'boom'), false);
});

test('a different message is not deduped by an unrelated one', () => {
  const state = beacon.makeState();
  beacon.recordReport(state, 'boom');
  assert.equal(beacon.shouldReport(state, 'crash'), true);
});

test('caps reports at MAX_REPORTS_PER_SESSION even for distinct messages', () => {
  const state = beacon.makeState();
  for (let i = 0; i < beacon.MAX_REPORTS_PER_SESSION; i++) {
    const msg = `error #${i}`;
    assert.equal(beacon.shouldReport(state, msg), true, `expected report #${i} to be allowed`);
    beacon.recordReport(state, msg);
  }
  assert.equal(beacon.shouldReport(state, 'one too many'), false);
});

test('ignore-list excludes known-benign audio play() rejections', () => {
  const state = beacon.makeState();
  assert.equal(beacon.shouldReport(state, 'play() failed because the user didn\'t interact first'), false);
  assert.equal(beacon.shouldReport(state, 'The play() request was interrupted by a call to pause()'), false);
});

test('ignore-list is not a blanket match on unrelated messages', () => {
  const state = beacon.makeState();
  assert.equal(beacon.shouldReport(state, 'Cannot read properties of undefined (reading \'foo\')'), true);
});

test('an ignored message never consumes the report budget or the dedupe set', () => {
  const state = beacon.makeState();
  beacon.shouldReport(state, "play() failed because the user didn't interact first");
  // Nothing was recorded (install() only calls recordReport() when
  // shouldReport() returned true) -- a real error right after should
  // still get its full budget.
  assert.equal(state.reportCount, 0);
  assert.equal(beacon.shouldReport(state, 'a real bug'), true);
});
