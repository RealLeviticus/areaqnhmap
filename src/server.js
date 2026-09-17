/**
 * The whole application: static site, upstream caches, JSON API, and the
 * screenshot renderer, in one process.
 *
 * Previously this was spread across GitHub Pages, three Cloudflare Workers, an
 * R2 bucket and a GitHub Actions job. Two of those Workers existed purely to
 * add CORS headers to someone else's data -- a problem that disappears entirely
 * once the page and the fetcher share an origin.
 */
import express from 'express';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { config, imagesDir } from './config.js';
import { fetchAreaQnh, revisionOf, BOM_URL } from './bom.js';
import { Feed, fetchAirspace } from './upstream.js';
import { imageStatus, renderIfChanged, REGION_CODES, imageName } from './screenshots.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');

const qnhFeed = new Feed({
  name: 'qnh',
  load: () => fetchAreaQnh({ timeoutMs: config.bom.timeoutMs }),
  refreshMs: config.bom.refreshMs,
  staleMs: config.bom.staleMs,
});

const airspaceFeed = new Feed({
  name: 'airspace',
  load: () => fetchAirspace(config.airspace),
  refreshMs: config.airspace.refreshMs,
});

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  // ---- API ---------------------------------------------------------------

  /**
   * The parsed Area QNH forecast.
   *
   * max-age is short because an amendment can land at any time, but the server
   * answers from memory either way -- this only controls Cloudflare's edge and
   * the browser, never whether we hit BOM.
   */
  app.get('/api/qnh', async (_req, res) => {
    const forecast = await qnhFeed.get();
    if (!forecast) {
      return res.status(503).json({
        error: 'No Area QNH forecast available yet',
        upstream: BOM_URL,
        detail: qnhFeed.lastError?.message ?? null,
      });
    }

    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
    res.json({
      ...forecast,
      revision: revisionOf(forecast),
      stale: qnhFeed.isStale,
      servedAt: new Date().toISOString(),
    });
  });

  /**
   * The vatSys airspace dataset, used to resolve waypoint identifiers.
   * Cached hard: it only changes per AIRAC cycle.
   */
  app.get('/api/airspace', async (_req, res) => {
    const xml = await airspaceFeed.get();
    if (!xml) {
      return res.status(503).type('text/plain').send('Airspace dataset unavailable');
    }
    res.set('Cache-Control', 'public, max-age=21600');
    res.type('application/xml').send(xml);
  });

  /** Health and freshness of everything, in one place. */
  app.get('/api/status', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      status: qnhFeed.value ? 'ok' : 'degraded',
      version: process.env.APP_VERSION ?? 'dev',
      uptimeSeconds: Math.round(process.uptime()),
      feeds: { qnh: qnhFeed.status(), airspace: airspaceFeed.status() },
      screenshots: config.screenshots.enabled ? await imageStatus() : { enabled: false },
    });
  });

  /** Liveness probe for Docker; deliberately does no upstream work. */
  app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

  // ---- Rendered images ---------------------------------------------------

  app.get('/images/:file', (req, res, next) => {
    const { file } = req.params;
    // Only ever serve the names we generate -- no user-controlled path reaches
    // the filesystem.
    if (!REGION_CODES.some(code => imageName(code) === file)) return next();

    res.sendFile(join(imagesDir, file), {
      maxAge: '60s',
      headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=3600' },
    }, err => {
      if (err) res.status(404).type('text/plain').send('Image not generated yet');
    });
  });

  // ---- Static site -------------------------------------------------------

  // MapLibre is served from node_modules rather than a CDN, so the version is
  // pinned in package.json and the screenshot renderer has no external
  // dependency to fail on.
  app.use('/vendor', express.static(join(ROOT, 'node_modules/maplibre-gl/dist'), {
    immutable: true,
    maxAge: '30d',
  }));

  app.use(express.static(PUBLIC_DIR, {
    extensions: ['html'],
    setHeaders(res, path) {
      // The bundled basemap only changes when someone reruns build-basemap.
      if (path.endsWith('basemap.json') || path.endsWith('vfr_fallback.json')) {
        res.set('Cache-Control', 'public, max-age=86400');
      }
    },
  }));

  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

  return app;
}

/** Re-render the images whenever the forecast revision changes. */
function startRenderLoop(baseUrl) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const forecast = await qnhFeed.get();
      if (!forecast) return;
      const result = await renderIfChanged(baseUrl, revisionOf(forecast));
      if (result.rendered) console.log(`[render] complete (${result.reason})`);
    } catch (err) {
      console.error(`[render] failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  // Give the server a moment to start answering before pointing a browser at it.
  setTimeout(tick, 5_000).unref?.();
  setInterval(tick, config.screenshots.checkMs).unref?.();
}

async function main() {
  await mkdir(imagesDir, { recursive: true });

  qnhFeed.start();
  airspaceFeed.start();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`areaqnhmap listening on :${config.port}`);
    console.log(`  BOM refresh every ${Math.round(config.bom.refreshMs / 1000)}s`);

    if (config.screenshots.enabled) {
      const baseUrl = config.screenshots.baseUrl ?? `http://127.0.0.1:${config.port}`;
      console.log(`  rendering images from ${baseUrl}`);
      startRenderLoop(baseUrl);
    } else {
      console.log('  screenshot rendering disabled');
    }
  });

  const shutdown = signal => {
    console.log(`${signal} received, shutting down`);
    qnhFeed.stop();
    airspaceFeed.stop();
    server.close(() => process.exit(0));
    // Don't let a hung connection block the container stop.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only run the server when executed directly, so tests can import createApp.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export { qnhFeed, airspaceFeed };
