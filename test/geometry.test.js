import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  pointInPoly, isPointOnCompassSideOfLine, isPointBetweenLines,
  ruleIndexForPoint, clipLine, extendLine,
  splitRingByLine, halfOnCompassSide, resolveRulePolygons, pointMatchesRule,
} from '../public/js/geometry.js';

/** A 10x10 box from (0,0) to (10,10), closed. */
const BOX = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];

test('pointInPoly distinguishes inside from outside', () => {
  assert.equal(pointInPoly([5, 5], BOX), true);
  assert.equal(pointInPoly([15, 5], BOX), false);
});

test('compass side of a horizontal line', () => {
  const line = [[0, 5], [10, 5]];

  assert.equal(isPointOnCompassSideOfLine([5, 8], line, 'N'), true);
  assert.equal(isPointOnCompassSideOfLine([5, 2], line, 'N'), false);
  assert.equal(isPointOnCompassSideOfLine([5, 2], line, 'S'), true);
});

test('compass side is independent of the order the line was written in', () => {
  const west = [[0, 5], [10, 5]];
  const east = [[10, 5], [0, 5]];

  for (const dir of ['N', 'S']) {
    assert.equal(
      isPointOnCompassSideOfLine([5, 8], west, dir),
      isPointOnCompassSideOfLine([5, 8], east, dir),
      `reversing the line changed the ${dir} side`);
  }
});

test('a line parallel to the requested direction falls back to projection', () => {
  // Asking for "E OF" a north-south line: the segment normal carries no
  // east-west information, so the point is compared along the compass axis.
  const line = [[5, 0], [5, 10]];

  assert.equal(isPointOnCompassSideOfLine([8, 5], line, 'E'), true);
  assert.equal(isPointOnCompassSideOfLine([2, 5], line, 'E'), false);
});

test('isPointBetweenLines finds the band between two parallel lines', () => {
  const lower = [[0, 3], [10, 3]];
  const upper = [[0, 7], [10, 7]];

  assert.equal(isPointBetweenLines([5, 5], lower, upper), true);
  assert.equal(isPointBetweenLines([5, 1], lower, upper), false);
  assert.equal(isPointBetweenLines([5, 9], lower, upper), false);
});

test('isPointBetweenLines ignores the direction each line was written in', () => {
  // This is the Area 45 bug: BOM wrote "BETWEEN YCOE/YCRY AND YGTN/YCKN" with
  // the two lines running head-to-head, which inverted the zone and swapped the
  // BETWEEN and REST values on the map.
  const lower = [[0, 3], [10, 3]];
  const upper = [[0, 7], [10, 7]];
  const upperReversed = [[10, 7], [0, 7]];

  for (const probe of [[5, 5], [5, 1], [5, 9]]) {
    assert.equal(
      isPointBetweenLines(probe, lower, upperReversed),
      isPointBetweenLines(probe, lower, upper),
      `reversing the second line changed the result at ${probe}`);
  }
});

test('ruleIndexForPoint gives every point exactly one rule', () => {
  // "N OF y=7 -> 1019, BETWEEN y=3 AND y=7 -> 1016, REST -> 1013"
  const rules = [
    { type: 'of', dir: 'N', lhs: 'upper', qnh: 1019 },
    { type: 'between', lhs: 'lower', rhs: 'upper', qnh: 1016 },
    { type: 'rest', qnh: 1013 },
  ];
  const geoms = [
    { lhs: [[0, 7], [10, 7]] },
    { lhs: [[0, 3], [10, 3]], rhs: [[0, 7], [10, 7]] },
    {},
  ];

  assert.equal(ruleIndexForPoint([5, 9], rules, geoms), 0);
  assert.equal(ruleIndexForPoint([5, 5], rules, geoms), 1);
  assert.equal(ruleIndexForPoint([5, 1], rules, geoms), 2);
});

test('ruleIndexForPoint leaves no point unassigned when a REST rule exists', () => {
  const rules = [
    { type: 'of', dir: 'N', lhs: 'upper', qnh: 1019 },
    { type: 'rest', qnh: 1013 },
  ];
  const geoms = [{ lhs: [[0, 7], [10, 7]] }, {}];

  for (let y = 0; y <= 10; y++) {
    assert.notEqual(ruleIndexForPoint([5, y], rules, geoms), -1, `y=${y} was unassigned`);
  }
});

test('earlier rules win, matching the order BOM writes subdivisions', () => {
  // Both rules match a point in the far north; the first one listed must win.
  const rules = [
    { type: 'of', dir: 'N', lhs: 'a', qnh: 1019 },
    { type: 'of', dir: 'N', lhs: 'b', qnh: 1016 },
    { type: 'rest', qnh: 1013 },
  ];
  const geoms = [{ lhs: [[0, 7], [10, 7]] }, { lhs: [[0, 3], [10, 3]] }, {}];

  assert.equal(ruleIndexForPoint([5, 9], rules, geoms), 0);
});

test('extendLine reaches the area boundary at both ends', () => {
  const extended = extendLine([[4, 5], [6, 5]], BOX);

  assert.equal(extended[0][0], 0);
  assert.equal(extended[extended.length - 1][0], 10);
});

test('clipLine separates the in-area portion from the extension', () => {
  const { solid, dashed } = clipLine([[-5, 5], [5, 5], [15, 5]], BOX);

  assert.ok(solid.length > 0, 'expected a solid portion inside the box');
  assert.ok(dashed.length > 0, 'expected a dashed portion outside the box');
});

// ---------------------------------------------------------------------------
// Splitting an area by a dividing line
// ---------------------------------------------------------------------------

test('splitRingByLine cuts a box into two pieces that between them hold every point', () => {
  const halves = splitRingByLine(BOX, [[-5, 5], [15, 5]]);
  assert.ok(halves, 'expected the line to cut the box');

  const [a, b] = halves;
  for (let x = 1; x < 10; x++) {
    for (let y = 1; y < 10; y++) {
      const inA = pointInPoly([x, y], a);
      const inB = pointInPoly([x, y], b);
      assert.notEqual(inA, inB, `(${x},${y}) was in ${inA ? 'both' : 'neither'} half`);
    }
  }
});

test('halfOnCompassSide picks the piece that actually lies that way', () => {
  const north = halfOnCompassSide(BOX, [[-5, 5], [15, 5]], 'N');

  assert.ok(pointInPoly([5, 8], north), 'the northern half should contain (5,8)');
  assert.ok(!pointInPoly([5, 2], north), 'the northern half should not contain (5,2)');
});

test('a bent divider classifies points past the bend consistently', () => {
  // Area 68's shape: "N OF" a line that runs west and then turns south. Both
  // probes sit in the same connected region, so both must be "N OF".
  // The nearest-segment test got this wrong and put REST's label here.
  const line = extendLine([[8, 5], [3, 5], [3, 1]], BOX);
  const north = halfOnCompassSide(BOX, line, 'N');

  assert.ok(north, 'expected the bent divider to cut the box');
  assert.ok(pointInPoly([5, 8], north), 'clearly north of the horizontal leg');
  assert.ok(pointInPoly([1, 3], north), 'west of the bend, same region as the point above');
  assert.ok(!pointInPoly([6, 2], north), 'south-east of the bend is the other region');
});

test('resolveRulePolygons gives a BETWEEN rule two half-polygons', () => {
  const geom = {
    lhs: extendLine([[2, 3], [8, 3]], BOX),
    rhs: extendLine([[2, 7], [8, 7]], BOX),
  };
  const rule = { type: 'between', lhs: 'a', rhs: 'b', qnh: 1016 };
  const resolved = resolveRulePolygons(rule, geom, BOX);

  assert.equal(resolved.polys.length, 2);
  assert.equal(pointMatchesRule([5, 5], rule, resolved), true);
  assert.equal(pointMatchesRule([5, 1], rule, resolved), false);
  assert.equal(pointMatchesRule([5, 9], rule, resolved), false);
});

test('BETWEEN via polygons is still immune to the order the lines were written', () => {
  const forward = resolveRulePolygons(
    { type: 'between', qnh: 1 },
    { lhs: extendLine([[2, 3], [8, 3]], BOX), rhs: extendLine([[2, 7], [8, 7]], BOX) },
    BOX);
  const reversed = resolveRulePolygons(
    { type: 'between', qnh: 1 },
    { lhs: extendLine([[2, 3], [8, 3]], BOX), rhs: extendLine([[8, 7], [2, 7]], BOX) },
    BOX);

  const rule = { type: 'between', qnh: 1 };
  for (const probe of [[5, 5], [5, 1], [5, 9]]) {
    assert.equal(
      pointMatchesRule(probe, rule, reversed),
      pointMatchesRule(probe, rule, forward),
      `reversing the second line changed the result at ${probe}`);
  }
});
