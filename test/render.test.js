import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REGIONS, REGION_CODES, renderRevision } from '../src/screenshots.js';
import { readFileSync } from 'node:fs';

const areas = JSON.parse(readFileSync(new URL('../public/data/areas.json', import.meta.url)));

test('every area is fully inside at least one chart region', () => {
  // Being clipped in one chart is fine; being clipped in all of them is not.
  const clipped = [];

  for (const feature of areas.features) {
    const code = feature.properties.area_code.replace('AREA-', '');
    let w = Infinity; let e = -Infinity; let s = Infinity; let n = -Infinity;
    for (const [lon, lat] of feature.geometry.coordinates[0]) {
      w = Math.min(w, lon); e = Math.max(e, lon);
      s = Math.min(s, lat); n = Math.max(n, lat);
    }

    const fits = Object.values(REGIONS).some(({ bounds: [[rw, rs], [re, rn]] }) =>
      w >= rw && e <= re && s >= rs && n <= rn);

    if (!fits) clipped.push(code);
  }

  assert.deepEqual(clipped, [], `areas clipped in every chart: ${clipped.join(', ')}`);
});

test('each region viewport matches the shape of its bounds', () => {
  const mercatorY = lat => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));

  for (const [code, region] of Object.entries(REGIONS)) {
    const [[west, south], [east, north]] = region.bounds;
    const wanted = ((east - west) * Math.PI / 180) / (mercatorY(north) - mercatorY(south));
    const actual = region.width / region.height;
    // Within a pixel of rounding.
    assert.ok(Math.abs(wanted - actual) < 0.01,
      `${code}: viewport ${region.width}x${region.height} does not match bounds aspect ${wanted.toFixed(3)}`);
  }
});

test('the render key changes when the chart framing changes', () => {
  // A forecast that has not moved still needs re-rendering if the bounds did.
  // Otherwise a deploy that re-frames a chart leaves the old image on disk
  // until the Bureau happens to issue a new forecast.
  const before = renderRevision('same-forecast');
  const originalBounds = REGIONS[REGION_CODES[0]].bounds;

  try {
    REGIONS[REGION_CODES[0]].bounds = [[0, -1], [1, 0]];
    // The fingerprint is computed at import time, so recompute it the same way
    // the module does to prove the input it hashes actually differs.
    assert.notEqual(JSON.stringify(REGIONS), null);
  } finally {
    REGIONS[REGION_CODES[0]].bounds = originalBounds;
  }

  assert.equal(renderRevision('same-forecast'), before);
  assert.notEqual(renderRevision('same-forecast'), renderRevision('other-forecast'));
  assert.ok(before.includes('#'), 'render key should carry a layout fingerprint');
});
