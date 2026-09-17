import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAreaQnh, parseRules, revisionOf } from '../src/bom.js';

/**
 * A cut-down copy of the real BOM markup: two states, one of them amended, and
 * areas covering every subdivision form the Bureau actually publishes.
 */
const FIXTURE = `
<html><body>
  <div id="tabs" class="areaqnh">
    <div class="areaqnh min-height" id="nsw">
      <div class="aq-dates">
        <span class="aq-title">Valid:</span>
        <span class="aq-date valid">1300 UTC - 1600 UTC 17 September 2026</span>
        <span class="aq-title">Issued:</span>
        <span class="aq-date issued">1204 UTC 17 September 2026</span>
      </div>
      <h3>New South Wales</h3>
      <div class="aq-region">
        <dl class="aq-list">
          <dt>Area 20:</dt>
          <dd>1029</dd>
          <dt>Area 24:</dt>
          <dd>E OF 33S156E/29S156E 1024,<br />REST 1027<br /></dd>
        </dl>
      </div>
    </div>
    <div class="areaqnh min-height" id="qld">
      <div class="aq-dates">
        <span class="aq-title">Valid:</span>
        <span class="aq-date valid">AMD 2200 UTC - 0100 UTC 17 September 2026</span>
        <span class="aq-title">Issued:</span>
        <span class="aq-date issued">2130 UTC 17 September 2026</span>
      </div>
      <h3>Queensland</h3>
      <div class="aq-region">
        <dl class="aq-list">
          <dt>Area 45:</dt>
          <dd>SE OF YGTN/YCKN 1022,<br />BETWEEN YCOE/YCRY AND YGTN/YCKN 1019,<br />REST 1016<br /></dd>
        </dl>
      </div>
    </div>
  </div>
</body></html>`;

test('parses each state block with its own stamps', () => {
  const f = parseAreaQnh(FIXTURE);

  assert.equal(f.states.nsw.name, 'New South Wales');
  assert.equal(f.states.nsw.issued, '2026-09-17T12:04:00.000Z');
  assert.equal(f.states.nsw.validFrom, '2026-09-17T13:00:00.000Z');
  assert.equal(f.states.nsw.validTo, '2026-09-17T16:00:00.000Z');
  assert.equal(f.states.nsw.amended, false);
});

test('an amendment to one state does not mark the others amended', () => {
  const f = parseAreaQnh(FIXTURE);

  assert.equal(f.states.qld.amended, true);
  assert.equal(f.states.nsw.amended, false);
  // ...but the country-level flag reflects that something was amended.
  assert.equal(f.amended, true);
});

test('a validity crossing midnight UTC ends on the following day', () => {
  const f = parseAreaQnh(FIXTURE);

  // "2200 UTC - 0100 UTC 17 September" ends at 0100 on the 18th.
  assert.equal(f.states.qld.validFrom, '2026-09-17T22:00:00.000Z');
  assert.equal(f.states.qld.validTo, '2026-09-18T01:00:00.000Z');
});

test('an undivided area exposes a plain qnh value', () => {
  const f = parseAreaQnh(FIXTURE);

  assert.equal(f.areas['20'].qnh, 1029);
  assert.deepEqual(f.areas['20'].rules, [{ type: 'all', qnh: 1029 }]);
  assert.equal(f.areas['20'].state, 'nsw');
});

test('a divided area has no single qnh and keeps clause order', () => {
  const f = parseAreaQnh(FIXTURE);

  assert.equal(f.areas['45'].qnh, null);
  assert.deepEqual(f.areas['45'].rules, [
    { type: 'of', dir: 'SE', lhs: 'YGTN/YCKN', qnh: 1022 },
    { type: 'between', lhs: 'YCOE/YCRY', rhs: 'YGTN/YCKN', qnh: 1019 },
    { type: 'rest', qnh: 1016 },
  ]);
});

test('a clause containing both a direction and BETWEEN is not split across rules', () => {
  // The previous implementation scanned the whole forecast with three separate
  // global regexes, so "BETWEEN ... AND ..." also matched the "N OF" pattern.
  const rules = parseRules('BETWEEN YAAA/YBBB AND YCCC/YDDD 1019, REST 1016');

  assert.equal(rules.length, 2);
  assert.equal(rules[0].type, 'between');
  assert.equal(rules[1].type, 'rest');
});

test('coordinate references survive tokenising', () => {
  const rules = parseRules('E OF 33S156E/29S156E 1024, REST 1027');

  assert.deepEqual(rules[0], { type: 'of', dir: 'E', lhs: '33S156E/29S156E', qnh: 1024 });
});

test('an unrecognised clause is surfaced, not dropped', () => {
  const rules = parseRules('ABOVE THE CLOUDS 1013, REST 1016');

  assert.equal(rules[0].type, 'unparsed');
  assert.equal(rules[0].text, 'ABOVE THE CLOUDS 1013');
  assert.equal(rules[1].qnh, 1016);
});

test('the revision changes when any state is reissued', () => {
  const before = revisionOf(parseAreaQnh(FIXTURE));
  const after = revisionOf(parseAreaQnh(FIXTURE.replace('1204 UTC', '1504 UTC')));

  assert.notEqual(before, after);
});

test('a page with no area entries is an error rather than an empty forecast', () => {
  assert.throws(() => parseAreaQnh('<html><body><p>Service unavailable</p></body></html>'),
    /no Area QNH entries/);
});
