/**
 * Renders the map to PNGs for the static-image page.
 *
 * This used to be a GitHub Actions job that booted Ubuntu, installed Chromium,
 * screenshotted the public site, pushed to R2 and then committed a timestamp
 * file back to the repo -- which is where the ~2000 "Update QNH issued cache"
 * commits came from. It now runs in-process against our own server, so there is
 * no CI, no object store, no bot commits, and the renderer is always looking at
 * exactly the code it was deployed with.
 */
import { mkdir, readFile, writeFile, rename, stat, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

import { config, imagesDir, stateFile } from './config.js';

/** Web Mercator y, in the same units as longitude-in-radians. */
const mercatorY = lat => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));

/**
 * Viewport that matches the shape of the bounds.
 *
 * fitBounds fits the whole box inside the viewport and pads whichever axis is
 * slack, so a viewport whose aspect ratio doesn't match the region leaves a
 * band of empty ocean down two sides. Deriving the height from the region's own
 * Mercator aspect ratio makes every chart fill its frame.
 */
function viewport([[west, south], [east, north]], targetWidth) {
  const aspect = ((east - west) * Math.PI / 180) / (mercatorY(north) - mercatorY(south));
  return { width: targetWidth, height: Math.round(targetWidth / aspect) };
}

/**
 * Which Area QNH zones each chart must show in full.
 *
 * Bounds are derived from these lists rather than hand-tuned, because nudging
 * a corner by eye is how areas kept ending up half cut off: widening a chart
 * to rescue one area quietly clipped another. Listing the areas states the
 * intent, and the frame follows from the polygons.
 *
 * An area may be clipped in some charts as long as one chart shows it whole;
 * test/render.test.js enforces that.
 */
const REGION_CONTENTS = {
  au: { name: 'Australia', scale: 0.043, areas: 'all' },
  wa: {
    name: 'Western Australia',
    areas: ['60', '61', '62', '63', '64', '65', '66', '68', '69', '83', '86', '87', '88'],
  },
  ce: {
    name: 'Central',
    areas: ['50', '51', '52', '53', '64', '80', '83', '84', '85', '86'],
  },
  se: {
    name: 'South East',
    // 24 reaches 163E (and contains Lord Howe Island); 53 starts at 129E.
    areas: ['20', '21', '22', '24', '30', '50', '51', '52', '53', '70'],
  },
  ne: {
    name: 'North East',
    // Deliberately no 80: including the Top End drags the frame far enough
    // west to change the chart's character. Area 80 is whole on the Central
    // and Australia charts.
    areas: ['40', '41', '43', '44', '45'],
  },
};

/** Breathing room around the areas, in degrees, so labels aren't cut. */
const MARGIN = 1.1;

/** Degrees of longitude per pixel. Shared so every detail chart reads alike. */
const DETAIL_SCALE = 0.027;

function boundsFor(areaCodes, areasGeoJSON) {
  const wanted = areaCodes === 'all'
    ? null
    : new Set(areaCodes.map(code => `AREA-${code}`));

  let w = Infinity; let e = -Infinity; let s = Infinity; let n = -Infinity;
  for (const feature of areasGeoJSON.features) {
    if (wanted && !wanted.has(feature.properties.area_code)) continue;
    for (const [lon, lat] of feature.geometry.coordinates[0]) {
      w = Math.min(w, lon); e = Math.max(e, lon);
      s = Math.min(s, lat); n = Math.max(n, lat);
    }
  }

  return [
    [round(w - MARGIN), round(s - MARGIN)],
    [round(e + MARGIN), round(n + MARGIN)],
  ];
}

const round = v => Math.round(v * 10) / 10;

const AREAS = JSON.parse(
  readFileSync(new URL('../public/data/areas.json', import.meta.url), 'utf8'));

export const REGIONS = Object.fromEntries(
  Object.entries(REGION_CONTENTS).map(([code, region]) => {
    const bounds = boundsFor(region.areas, AREAS);
    const width = Math.round((bounds[1][0] - bounds[0][0]) / (region.scale ?? DETAIL_SCALE));
    return [code, { name: region.name, bounds, ...viewport(bounds, width) }];
  }));

export const REGION_CODES = Object.keys(REGIONS);
export const imageName = code => `qnh-${code}.png`;

/**
 * Fingerprint of the framing itself.
 *
 * The forecast is not the only thing that changes what a chart should look
 * like -- so does editing a region's bounds. Without this, widening the South
 * East chart to stop clipping Area 24 deployed the new code but left the old
 * images on disk until the Bureau happened to issue a new forecast.
 */
const LAYOUT_REVISION = createHash('sha256')
  .update(JSON.stringify(REGIONS))
  .digest('hex')
  .slice(0, 12);

/** The key that decides whether the rendered images are still current. */
export const renderRevision = forecastRevision =>
  `${forecastRevision ?? 'none'}#${LAYOUT_REVISION}`;

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    return { revision: null, renderedAt: null };
  }
}

async function writeState(state) {
  // Write-then-rename so a crash mid-write can't leave an unparseable file.
  const tmp = `${stateFile}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, stateFile);
}

/**
 * Renders every region and writes them into the images directory.
 * @param {string} baseUrl origin serving the map, e.g. http://127.0.0.1:8080
 */
export async function renderAll(baseUrl, { log = console.log } = {}) {
  await mkdir(imagesDir, { recursive: true });

  const launchOptions = {
    // "new" headless renders WebGL correctly under SwiftShader; the old
    // headless mode needed an Xvfb display, which is why the CI job ran one.
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  };
  if (config.screenshots.executablePath) {
    launchOptions.executablePath = config.screenshots.executablePath;
  }

  const browser = await puppeteer.launch(launchOptions);
  const written = [];

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(config.screenshots.timeoutMs);
    page.on('pageerror', err => log(`[render] page error: ${err.message}`));
    page.on('requestfailed', req =>
      log(`[render] request failed: ${req.url()} ${req.failure()?.errorText ?? ''}`));

    const url = new URL('/index.html', baseUrl);
    url.searchParams.set('screenshot', '1');
    log(`[render] loading ${url}`);
    await page.goto(url.toString(), { waitUntil: 'networkidle2' });

    // The page sets this once the basemap, the areas and the QNH labels are all
    // drawn. Waiting on an explicit signal beats the fixed sleeps the old job
    // used -- those were both slower than necessary and occasionally too short.
    await page.waitForFunction(() => window.__mapReady === true);

    for (const [code, region] of Object.entries(REGIONS)) {
      log(`[render] ${code} (${region.name})`);

      await page.setViewport({
        width: region.width,
        height: region.height,
        deviceScaleFactor: 2,
      });

      await page.evaluate(bounds => window.__fitBounds(bounds), region.bounds);
      await page.waitForFunction(() => window.__mapIdle === true);

      const target = join(imagesDir, imageName(code));
      const tmp = `${target}.tmp`;
      const element = await page.$('#map');
      await element.screenshot({ path: tmp, type: 'png' });
      await rename(tmp, target);
      written.push(imageName(code));
    }
  } finally {
    await browser.close();
  }

  log(`[render] wrote ${written.length} image(s)`);
  return written;
}

/**
 * Renders only if the forecast has changed since the last render.
 * @param {string} revision current forecast revision, from revisionOf()
 */
export async function renderIfChanged(baseUrl, forecastRevision, { force = false, log = console.log } = {}) {
  const revision = renderRevision(forecastRevision);
  const state = await readState();

  if (!force && state.revision === revision && await imagesPresent()) {
    return { rendered: false, reason: 'unchanged', revision };
  }

  const reason = force ? 'forced'
    : state.revision && state.revision.split('#')[1] !== LAYOUT_REVISION ? 'layout changed'
      : 'forecast changed';

  log(`[render] ${reason}`);
  const images = await renderAll(baseUrl, { log });
  await writeState({
    revision,
    forecastRevision: forecastRevision ?? null,
    renderedAt: new Date().toISOString(),
    images,
  });

  return { rendered: true, reason, revision, images };
}

/** True only if every expected image actually exists on disk. */
async function imagesPresent() {
  try {
    const present = new Set(await readdir(imagesDir));
    return REGION_CODES.every(code => present.has(imageName(code)));
  } catch {
    return false;
  }
}

/** Per-image freshness, for the status endpoint and the static page. */
export async function imageStatus() {
  const state = await readState();
  const images = {};

  for (const code of REGION_CODES) {
    const name = imageName(code);
    try {
      const info = await stat(join(imagesDir, name));
      images[code] = {
        name,
        region: REGIONS[code].name,
        bytes: info.size,
        modified: info.mtime.toISOString(),
      };
    } catch {
      images[code] = { name, region: REGIONS[code].name, available: false };
    }
  }

  return { revision: state.revision, renderedAt: state.renderedAt, images };
}
