/* Issue #209 (calendar half) -- the practical.html "Add to calendar"
   buttons point at static hand-written .ics files. No icalendar library
   in play (Node built-ins only, same convention as the rest of this
   repo's test suite) -- these checks parse just enough of RFC 5545 to
   catch a malformed file (missing CRLF, unbalanced BEGIN/END, a wrong
   date) without pulling in a dependency for four static files that never
   change at runtime. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAL_DIR = path.join(ROOT, 'calendar');

// RFC 5545 requires CRLF line endings -- a file authored/edited with a
// plain text editor can easily end up LF-only, which some calendar apps
// (notably older Android clients) fail to parse at all.
function assertCrlf(raw, file) {
  assert.ok(raw.includes('\r\n'), `${file}: expected CRLF line endings`);
  const withoutCrlf = raw.split('\r\n').join('');
  assert.ok(!withoutCrlf.includes('\n'), `${file}: found a bare LF not part of a CRLF pair`);
}

// Pulls one property's value out of an unfolded ICS body -- good enough
// for these single-VEVENT files where every property appears exactly
// once; doesn't attempt full RFC 5545 line-unfolding/parameter parsing.
function prop(raw, name) {
  const re = new RegExp(`^${name}(;[^:\r\n]*)?:(.*)$`, 'm');
  const m = re.exec(raw.replace(/\r\n/g, '\n'));
  return m ? m[2].trim() : null;
}

const FILES = {
  'day1-murray.ics': { dtstart: '20260807T120000', dtend: '20260807T163000', summaryContains: 'Day I', locationContains: 'Mulwala NSW 2647' },
  'day2-blackbull.ics': { dtstart: '20260808T120000', dtend: '20260808T163000', summaryContains: 'Day II', locationContains: 'Mulwala NSW 2647' },
  'day3-lake.ics': { dtstart: '20260809T100000', dtend: '20260809T143000', summaryContains: 'Day III', locationContains: 'Mulwala NSW 2647' },
  'weekend.ics': { dtstart: '20260807T140000', dtend: '20260809T100000', summaryContains: 'Weekend', locationContains: 'Anchorage Way' }
};

for (const [file, expect] of Object.entries(FILES)) {
  test(`calendar/${file}: exists, well-formed, CRLF line endings`, () => {
    const filePath = path.join(CAL_DIR, file);
    assert.ok(existsSync(filePath), `expected calendar/${file} to exist`);
    const raw = readFileSync(filePath, 'utf8');
    assertCrlf(raw, file);
    assert.equal((raw.match(/BEGIN:VCALENDAR/g) || []).length, 1);
    assert.equal((raw.match(/END:VCALENDAR/g) || []).length, 1);
    assert.equal((raw.match(/BEGIN:VEVENT/g) || []).length, 1);
    assert.equal((raw.match(/END:VEVENT/g) || []).length, 1);
    assert.equal((raw.match(/BEGIN:VTIMEZONE/g) || []).length, 1, `${file}: needs a VTIMEZONE block so it imports correctly regardless of the guest's home timezone`);
    assert.match(raw, /TZID:Australia\/Melbourne/, `${file}: VTIMEZONE must be Australia/Melbourne`);
  });

  test(`calendar/${file}: DTSTART/DTEND/SUMMARY/LOCATION match the published schedule`, () => {
    const raw = readFileSync(path.join(CAL_DIR, file), 'utf8');
    assert.match(prop(raw, 'DTSTART;TZID=Australia/Melbourne') || '', new RegExp(`^${expect.dtstart}$`));
    assert.match(prop(raw, 'DTEND;TZID=Australia/Melbourne') || '', new RegExp(`^${expect.dtend}$`));
    assert.ok((prop(raw, 'SUMMARY') || '').includes(expect.summaryContains), `${file}: SUMMARY should mention "${expect.summaryContains}"`);
    assert.ok((prop(raw, 'LOCATION') || '').includes(expect.locationContains), `${file}: LOCATION should mention "${expect.locationContains}"`);
  });

  test(`calendar/${file}: DTEND is after DTSTART`, () => {
    const raw = readFileSync(path.join(CAL_DIR, file), 'utf8');
    const parse = s => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`);
    const start = parse(prop(raw, 'DTSTART;TZID=Australia/Melbourne'));
    const end = parse(prop(raw, 'DTEND;TZID=Australia/Melbourne'));
    assert.ok(end > start, `${file}: DTEND (${end}) must be after DTSTART (${start})`);
  });

  test(`calendar/${file}: has a URL back to the live site`, () => {
    const raw = readFileSync(path.join(CAL_DIR, file), 'utf8');
    assert.match(prop(raw, 'URL') || '', /^https:\/\/thewongacup\.golf\//);
  });
}

test('every calendar/*.ics file has a unique UID', () => {
  const uids = Object.keys(FILES).map(file => prop(readFileSync(path.join(CAL_DIR, file), 'utf8'), 'UID'));
  assert.ok(uids.every(Boolean), 'every file must have a UID');
  assert.equal(new Set(uids).size, uids.length, 'UIDs must be unique across files');
});

test('practical.html links to all four calendar files', () => {
  const html = readFileSync(path.join(ROOT, 'practical.html'), 'utf8');
  for (const file of Object.keys(FILES)) {
    assert.match(html, new RegExp(`href="calendar/${file}"`), `expected practical.html to link to calendar/${file}`);
  }
});

test('deploy.yml assembles calendar/ into the _site/ deploy artifact', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(workflow, /cp -r calendar/, 'expected deploy.yml to copy calendar/ into _site/');
});
