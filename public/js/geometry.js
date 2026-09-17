/**
 * Pure planar geometry helpers for placing Area QNH subdivisions.
 *
 * Everything here works in raw [lon, lat] degrees and treats them as a flat
 * plane. That is not a correct projection, but BOM's subdivision boundaries are
 * themselves drawn as straight lines between named points on a chart, so
 * matching that behaviour is more faithful than being geodetically clever.
 *
 * No DOM or MapLibre access, so this module is unit-testable under Node.
 */

/** Ray casting. `ring` must be closed (first point repeated at the end). */
export function pointInPoly(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > pt[1]) !== (yj > pt[1]))
      && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from a point to the segment a-b. */
export function distToSeg(pt, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(pt[0] - a[0], pt[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / l2));
  return Math.hypot(pt[0] - (a[0] + t * dx), pt[1] - (a[1] + t * dy));
}

export function centroid(pts) {
  if (!pts.length) return [0, 0];
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  return [sx / pts.length, sy / pts.length];
}

export function bboxOf(ring) {
  let minX = Infinity; let minY = Infinity;
  let maxX = -Infinity; let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Grid of points inside the ring, used to approximate subdivision areas. */
export function samplePts(ring, n = 100) {
  if (!ring || ring.length < 3) return [];
  const { minX, minY, maxX, maxY } = bboxOf(ring);
  const sx = (maxX - minX) / n;
  const sy = (maxY - minY) / n;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const p = [minX + i * sx, minY + j * sy];
      if (pointInPoly(p, ring)) pts.push(p);
    }
  }
  return pts;
}

/**
 * Pole of inaccessibility: the interior point furthest from the ring's edges.
 * Used to place an area's label somewhere that looks deliberate.
 */
export function findLabelPos(ring, grid = 50) {
  if (!ring || ring.length < 3) return [0, 0];
  const { minX, minY, maxX, maxY } = bboxOf(ring);
  const sx = (maxX - minX) / grid;
  const sy = (maxY - minY) / grid;

  let best = null;
  let maxD = -Infinity;
  for (let i = 0; i <= grid; i++) {
    for (let j = 0; j <= grid; j++) {
      const pt = [minX + i * sx, minY + j * sy];
      if (!pointInPoly(pt, ring)) continue;
      let minDist = Infinity;
      for (let k = 0; k < ring.length - 1; k++) {
        minDist = Math.min(minDist, distToSeg(pt, ring[k], ring[k + 1]));
      }
      if (minDist > maxD) { maxD = minDist; best = pt; }
    }
  }

  if (best) return best;
  // Degenerate ring: fall back to the average of its vertices.
  return centroid(ring.slice(0, -1));
}

/**
 * 2D cross product of (lineEnd - lineStart) with (point - lineStart).
 * Positive means the point lies to the left of travel along the line.
 */
export function signedDistanceToLine(point, lineStart, lineEnd) {
  const dx = lineEnd[0] - lineStart[0];
  const dy = lineEnd[1] - lineStart[1];
  return dx * (point[1] - lineStart[1]) - dy * (point[0] - lineStart[0]);
}

const COMPASS = {
  N: [0, 1],
  S: [0, -1],
  E: [1, 0],
  W: [-1, 0],
  NE: [Math.SQRT1_2, Math.SQRT1_2],
  NW: [-Math.SQRT1_2, Math.SQRT1_2],
  SE: [Math.SQRT1_2, -Math.SQRT1_2],
  SW: [-Math.SQRT1_2, -Math.SQRT1_2],
};

/** Index of the segment of `lineCoords` nearest to `point`, plus that point. */
function nearestSegment(point, lineCoords) {
  let index = 0;
  let best = Infinity;
  let nearest = null;

  for (let i = 0; i < lineCoords.length - 1; i++) {
    const a = lineCoords[i];
    const b = lineCoords[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) continue;

    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / l2));
    const q = [a[0] + t * dx, a[1] + t * dy];
    const d2 = (point[0] - q[0]) ** 2 + (point[1] - q[1]) ** 2;
    if (d2 < best) { best = d2; index = i; nearest = q; }
  }

  return { index, nearest };
}

/**
 * Is `point` on the `direction` side of the (possibly multi-segment) line?
 *
 * BOM writes clauses like "N OF YRLL/YARY", where the line is a chain of named
 * points. We take the nearest segment and ask which of its two sides faces the
 * requested compass direction. When the segment runs almost parallel to that
 * direction the sides are ambiguous, so we fall back to projecting the point
 * onto the compass axis instead.
 */
export function isPointOnCompassSideOfLine(point, lineCoords, direction) {
  if (!lineCoords || lineCoords.length < 2) return false;
  const compass = COMPASS[direction];
  if (!compass) return false;

  const { index, nearest } = nearestSegment(point, lineCoords);
  const a = lineCoords[index];
  const b = lineCoords[index + 1];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const segLen = Math.hypot(dx, dy);
  if (segLen === 0) return false;

  const leftNormal = [-dy / segLen, dx / segLen];
  const dotWithLeft = leftNormal[0] * compass[0] + leftNormal[1] * compass[1];

  if (Math.abs(dotWithLeft) > 0.1) {
    const signed = signedDistanceToLine(point, a, b);
    return dotWithLeft > 0 ? signed > 0 : signed < 0;
  }

  const q = nearest ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return (point[0] - q[0]) * compass[0] + (point[1] - q[1]) * compass[1] > 0;
}

/** Which side of the polyline the point falls on, using its nearest segment. */
function signedSideOf(point, line) {
  const { index } = nearestSegment(point, line);
  return signedDistanceToLine(point, line[index], line[index + 1]);
}

/** Overall direction of a polyline, first vertex to last. */
const lineDirection = line => [
  line[line.length - 1][0] - line[0][0],
  line[line.length - 1][1] - line[0][1],
];

/**
 * Is `point` in the band between the two lines?
 *
 * Both lines are extended to the area boundary before they get here, so each
 * one cuts the area cleanly in two and "between" means "on opposite sides".
 *
 * That test only holds if the two lines are oriented consistently, and BOM
 * writes each one in whatever order reads best -- "BETWEEN YCOE/YCRY AND
 * YGTN/YCKN" runs the first line north-to-south and the second south-to-north.
 * Comparing raw signed distances therefore inverted the zone whenever the two
 * happened to be written head-to-head, which is what swapped Area 45's REST and
 * BETWEEN values. Flip the second line to agree with the first before testing.
 */
export function isPointBetweenLines(point, line1, line2) {
  if (!line1 || line1.length < 2 || !line2 || line2.length < 2) return false;

  const d1 = lineDirection(line1);
  const d2 = lineDirection(line2);
  const aligned = (d1[0] * d2[0] + d1[1] * d2[1]) < 0 ? [...line2].reverse() : line2;

  const side1 = signedSideOf(point, line1);
  const side2 = signedSideOf(point, aligned);

  return (side1 > 0 && side2 < 0) || (side1 < 0 && side2 > 0);
}

/**
 * Intersection of segments a-b and c-d, or null if they don't cross.
 *
 * `eps` widens both parameter ranges slightly. extendLine() ends its line
 * *exactly* on a ring edge, so re-detecting that crossing puts the parameter
 * right on 0 or 1, where rounding can push it just outside and the crossing
 * disappears. Callers that need to find those endpoint touches pass a small
 * tolerance; callers that want a strict interior crossing leave it at zero.
 */
export function lineInt(a, b, c, d, eps = 0) {
  const [x1, y1] = a; const [x2, y2] = b;
  const [x3, y3] = c; const [x4, y4] = d;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-12) return null;

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
  return (t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps)
    ? [x1 + t * (x2 - x1), y1 + t * (y2 - y1)]
    : null;
}

/** Where a ray from `pt` in `dir` first leaves the ring. */
function extendToBoundary(pt, dir, ring) {
  const far = [pt[0] + dir[0] * 1000, pt[1] + dir[1] * 1000];
  let best = null;
  let minD = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const hit = lineInt(pt, far, ring[i], ring[i + 1]);
    if (!hit) continue;
    const d = Math.hypot(hit[0] - pt[0], hit[1] - pt[1]);
    if (d > 0.0001 && d < minD) { minD = d; best = hit; }
  }
  return best;
}

/**
 * BOM names only the points the dividing line passes through, not where it meets
 * the area boundary. Extend the chain at both ends so it spans the whole area.
 */
export function extendLine(coords, ring) {
  if (!coords || coords.length < 2) return coords;

  const unit = (from, to) => {
    const d = [from[0] - to[0], from[1] - to[1]];
    const len = Math.hypot(d[0], d[1]);
    return len > 0 ? [d[0] / len, d[1] / len] : [0, 0];
  };

  const startExt = extendToBoundary(coords[0], unit(coords[0], coords[1]), ring);
  const last = coords.length - 1;
  const endExt = extendToBoundary(coords[last], unit(coords[last], coords[last - 1]), ring);

  return [...(startExt ? [startExt] : []), ...coords, ...(endExt ? [endExt] : [])];
}

/**
 * Split a line into the parts inside the ring and the parts outside it, so the
 * map can draw the in-area portion solid and the extension dashed -- which is
 * how BOM's own chart distinguishes them.
 */
export function clipLine(coords, ring) {
  const solid = [];
  const dashed = [];

  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const in1 = pointInPoly(p1, ring);
    const in2 = pointInPoly(p2, ring);

    if (in1 && in2) { solid.push([p1, p2]); continue; }

    if (!in1 && !in2) {
      // Both ends outside: the segment may still cut across the area.
      const crossings = [];
      for (let j = 0; j < ring.length - 1; j++) {
        const hit = lineInt(p1, p2, ring[j], ring[j + 1]);
        if (hit) crossings.push({ pt: hit, d: Math.hypot(hit[0] - p1[0], hit[1] - p1[1]) });
      }
      if (crossings.length >= 2) {
        crossings.sort((a, b) => a.d - b.d);
        dashed.push([p1, crossings[0].pt]);
        solid.push([crossings[0].pt, crossings[crossings.length - 1].pt]);
        dashed.push([crossings[crossings.length - 1].pt, p2]);
      } else {
        dashed.push([p1, p2]);
      }
      continue;
    }

    let crossing = null;
    for (let j = 0; j < ring.length - 1; j++) {
      const hit = lineInt(p1, p2, ring[j], ring[j + 1]);
      if (hit) { crossing = hit; break; }
    }

    if (crossing) {
      if (in1) { solid.push([p1, crossing]); dashed.push([crossing, p2]); }
      else { dashed.push([p1, crossing]); solid.push([crossing, p2]); }
    } else {
      solid.push([p1, p2]);
    }
  }

  return { solid, dashed };
}

/**
 * Best label position inside a subdivision.
 *
 * Prefers points far from every boundary (the area ring and the dividing lines)
 * but penalises drifting away from the zone's centre of mass, which otherwise
 * pushes labels into long thin corners.
 */
export function findBestZoneLabel(zone, ring, splitLines) {
  if (!zone || zone.length === 0) return null;
  if (zone.length === 1) return zone[0];

  const ctr = centroid(zone);
  let bestPt = null;
  let maxScore = -Infinity;

  for (const pt of zone) {
    let minDist = Infinity;

    for (let i = 0; i < ring.length - 1; i++) {
      minDist = Math.min(minDist, distToSeg(pt, ring[i], ring[i + 1]));
    }

    if (splitLines) {
      for (const line of splitLines) {
        if (!line || line.length < 2) continue;
        for (let i = 0; i < line.length - 1; i++) {
          minDist = Math.min(minDist, distToSeg(pt, line[i], line[i + 1]));
        }
      }
    }

    const score = minDist - Math.hypot(pt[0] - ctr[0], pt[1] - ctr[1]) * 0.3;
    if (score > maxScore) { maxScore = score; bestPt = pt; }
  }

  return (bestPt && maxScore > 0.01) ? bestPt : ctr;
}

// ---------------------------------------------------------------------------
// Splitting an area by a dividing line
// ---------------------------------------------------------------------------

/**
 * Cut a ring in two with a line that crosses it.
 *
 * Testing which side of a line a point falls on by looking at the nearest
 * segment works only for a straight divider. BOM's dividers bend: Area 68's
 * "N OF PVS/MSTM/YPBO" runs west and then turns south, and for a point past the
 * bend the nearest segment is the southbound leg, whose sides have nothing to
 * do with north. That put Area 68's REST label in the same connected region as
 * its "N OF" label.
 *
 * Because extendLine() has already carried the divider out to the ring, it
 * enters and leaves exactly once, so it genuinely cuts the area into two
 * connected pieces. Building those two polygons explicitly and then asking
 * point-in-polygon is exact, and it doesn't care how the divider bends.
 *
 * @returns {[number[][], number[][]]|null} the two rings, or null if the line
 *   does not cleanly cross the ring twice.
 */
export function splitRingByLine(ring, line) {
  if (!ring || ring.length < 4 || !line || line.length < 2) return null;

  // Every place the divider meets the ring, remembered with how far along the
  // divider it happened (so we can take the first and last) and which ring edge
  // it landed on (so we can walk the boundary between them).
  const CROSS_EPS = 1e-9;
  const hits = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);

    for (let j = 0; j < ring.length - 1; j++) {
      const pt = lineInt(a, b, ring[j], ring[j + 1], CROSS_EPS);
      if (!pt) continue;
      const along = i + (segLen ? Math.hypot(pt[0] - a[0], pt[1] - a[1]) / segLen : 0);
      hits.push({ pt, along, edge: j });
    }
  }

  // A crossing that lands on a ring vertex is reported by both edges meeting
  // there, and the widened tolerance can also report the same touch twice.
  // Collapse anything that is really the same point.
  hits.sort((p, q) => p.along - q.along);
  const unique = hits.filter((hit, i) => {
    if (i === 0) return true;
    const prev = hits[i - 1];
    return Math.hypot(hit.pt[0] - prev.pt[0], hit.pt[1] - prev.pt[1]) > 1e-7;
  });

  if (unique.length < 2) return null;

  const entry = unique[0];
  const exit = unique[unique.length - 1];
  if (entry.edge === exit.edge) {
    // Both ends land on the same ring edge, so the line only grazes a corner
    // rather than dividing the area.
    return null;
  }

  // The part of the divider actually inside the ring.
  const cut = [entry.pt];
  for (let i = 0; i < line.length; i++) {
    if (i > Math.floor(entry.along) && i <= Math.floor(exit.along)) cut.push(line[i]);
  }
  cut.push(exit.pt);

  /** Ring vertices walking forward from edge `from` up to edge `to`. */
  const walk = (from, to) => {
    const out = [];
    const n = ring.length - 1; // last vertex repeats the first
    let i = from;
    for (let guard = 0; guard <= n; guard++) {
      i = (i + 1) % n;
      out.push(ring[i]);
      if (i === to) break;
    }
    return out;
  };

  const sideA = [...cut, ...walk(exit.edge, entry.edge), entry.pt];
  const sideB = [...cut.slice().reverse(), ...walk(entry.edge, exit.edge), exit.pt];

  if (sideA.length < 4 || sideB.length < 4) return null;
  return [sideA, sideB];
}

/** Rough interior point of a ring, good enough for comparing two halves. */
const ringCentre = ring => centroid(ring.slice(0, -1));

/**
 * The half of `ring`, cut by `line`, that lies in the given compass direction.
 * Falls back to null when the line doesn't cut the ring cleanly.
 */
export function halfOnCompassSide(ring, line, direction) {
  const halves = splitRingByLine(ring, line);
  if (!halves) return null;

  const compass = COMPASS[direction];
  if (!compass) return null;

  // Whichever half's centre sits further along the compass axis is the one BOM
  // means. The two centres are always separated along the divider's normal, so
  // this comparison is stable.
  const [a, b] = halves;
  const ca = ringCentre(a);
  const cb = ringCentre(b);
  const projA = ca[0] * compass[0] + ca[1] * compass[1];
  const projB = cb[0] * compass[0] + cb[1] * compass[1];
  return projA >= projB ? a : b;
}

/** The half of `ring`, cut by `line`, that contains `reference`. */
export function halfContaining(ring, line, reference) {
  const halves = splitRingByLine(ring, line);
  if (!halves) return null;
  const [a, b] = halves;
  if (pointInPoly(reference, a)) return a;
  if (pointInPoly(reference, b)) return b;
  // `reference` sits on the divider itself; fall back to the nearer centre.
  const da = Math.hypot(...ringCentre(a).map((v, i) => v - reference[i]));
  const db = Math.hypot(...ringCentre(b).map((v, i) => v - reference[i]));
  return da <= db ? a : b;
}

/** Midpoint of a polyline, by vertex position. */
export const lineMidpoint = line => line[Math.floor(line.length / 2)];

/**
 * Does `point` satisfy this rule's geometry, ignoring rule priority?
 * `rest` matches everything; the caller applies the "not in any other zone" part.
 *
 * `geom.polys` is the precomputed list of half-polygons the point must lie in
 * (one for a direction rule, two for a BETWEEN). When the divider could not be
 * resolved into polygons we fall back to the half-plane tests, which are right
 * for a straight divider and better than drawing nothing.
 */
export function pointMatchesRule(point, rule, geom) {
  if (!rule || typeof rule.qnh !== 'number') return false;
  if (rule.type === 'rest' || rule.type === 'all') return true;

  if (geom?.polys?.length) {
    return geom.polys.every(poly => pointInPoly(point, poly));
  }

  if (rule.type === 'of' && rule.dir && geom?.lhs?.length >= 2) {
    return isPointOnCompassSideOfLine(point, geom.lhs, rule.dir);
  }
  if (rule.type === 'between' && geom?.lhs && geom?.rhs) {
    return isPointBetweenLines(point, geom.lhs, geom.rhs);
  }
  return false;
}

/**
 * Precompute the half-polygons for one rule.
 * @param {object} geom must already carry the extended `lhs` / `rhs` lines
 */
export function resolveRulePolygons(rule, geom, ring) {
  const polys = [];

  if (rule.type === 'of' && rule.dir && geom.lhs?.length >= 2) {
    const half = halfOnCompassSide(ring, geom.lhs, rule.dir);
    if (half) polys.push(half);
  }

  if (rule.type === 'between' && geom.lhs?.length >= 2 && geom.rhs?.length >= 2) {
    // "Between" is simply: on the side of each divider that faces the other.
    const a = halfContaining(ring, geom.lhs, lineMidpoint(geom.rhs));
    const b = halfContaining(ring, geom.rhs, lineMidpoint(geom.lhs));
    if (a && b) polys.push(a, b);
  }

  return { ...geom, polys };
}

/**
 * Resolve a point to exactly one rule, honouring BOM's ordering.
 *
 * BOM lists subdivisions most-specific-first and finishes with REST, so the
 * first explicit rule that matches wins and REST takes whatever is left over.
 * Returning a single index (rather than a membership array) is what keeps zones
 * from overlapping.
 */
export function ruleIndexForPoint(point, rules, geoms) {
  let restIndex = -1;

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (typeof rule?.qnh !== 'number') continue;
    if (rule.type === 'rest') { if (restIndex < 0) restIndex = i; continue; }
    if (rule.type === 'all') return i;
    if (pointMatchesRule(point, rule, geoms[i])) return i;
  }

  return restIndex;
}
