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
 * Regions to render, framed the way BOM frames its own chart set.
 * bounds: [[west, south], [east, north]]
 */
const REGION_BOUNDS = {
  au: { name: 'Australia', bounds: [[110, -45], [157, -8]], width: 1100 },
  // Reaches to 8S so Area 86 (Timor Sea) is whole, and east to 137E so the
  // central areas 84/85 are in frame rather than cut at the WA border.
  wa: { name: 'Western Australia', bounds: [[110, -37], [137, -8]], width: 1000 },
  se: { name: 'South East', bounds: [[131, -45], [156, -26]], width: 1000 },
  ne: { name: 'North East', bounds: [[135, -31], [157, -8]], width: 1000 },
};

export const REGIONS = Object.fromEntries(
  Object.entries(REGION_BOUNDS).map(([code, region]) => [
    code,
    { ...region, ...viewport(region.bounds, region.width) },
  ]));

export const REGION_CODES = Object.keys(REGIONS);
export const imageName = code => `qnh-${code}.png`;

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
export async function renderIfChanged(baseUrl, revision, { force = false, log = console.log } = {}) {
  const state = await readState();

  if (!force && revision && state.revision === revision && await imagesPresent()) {
    return { rendered: false, reason: 'unchanged', revision };
  }

  const images = await renderAll(baseUrl, { log });
  await writeState({
    revision: revision ?? null,
    renderedAt: new Date().toISOString(),
    images,
  });

  return { rendered: true, reason: force ? 'forced' : 'changed', revision, images };
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
