/**
 * All runtime configuration, in one place, read from the environment.
 *
 * Every value has a working default so that `npm start` with no environment at
 * all does the right thing. docker-compose.yml only sets what it needs to.
 */
import { resolve } from 'node:path';

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(value);
};

const MINUTE = 60_000;

export const config = {
  port: num(process.env.PORT, 8080),

  /** Writable state: rendered images and the screenshot bookkeeping file. */
  dataDir: resolve(process.env.DATA_DIR ?? 'data'),

  bom: {
    /**
     * How often to re-check BOM. Area QNH is issued every three hours, 45
     * minutes before each validity period, so polling every few minutes is
     * plenty to catch a new cycle or an amendment promptly without being
     * rude to a government website.
     */
    refreshMs: num(process.env.QNH_REFRESH_MS, 5 * MINUTE),
    /** Serve the last good forecast for this long if BOM goes away. */
    staleMs: num(process.env.QNH_STALE_MS, 6 * 60 * MINUTE),
    timeoutMs: num(process.env.QNH_TIMEOUT_MS, 20_000),
  },

  airspace: {
    /** vatSys publishes the Australian dataset; it changes per AIRAC cycle. */
    url: process.env.AIRSPACE_URL
      ?? 'https://raw.githubusercontent.com/vatSys/australia-dataset/master/Airspace.xml',
    refreshMs: num(process.env.AIRSPACE_REFRESH_MS, 12 * 60 * MINUTE),
    timeoutMs: num(process.env.AIRSPACE_TIMEOUT_MS, 60_000),
  },

  screenshots: {
    enabled: bool(process.env.SCREENSHOTS_ENABLED, true),
    /** Checked on this interval; only re-renders when the forecast changed. */
    checkMs: num(process.env.SCREENSHOT_CHECK_MS, 10 * MINUTE),
    /**
     * The map page the renderer points at. Defaults to this very server, which
     * is why the screenshot job has no external dependencies at all.
     */
    baseUrl: process.env.SCREENSHOT_BASE_URL ?? null,
    /** Chromium binary. The image sets this; locally, puppeteer finds its own. */
    executablePath: process.env.CHROME_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? null,
    timeoutMs: num(process.env.SCREENSHOT_TIMEOUT_MS, 180_000),
  },

  /** Trust X-Forwarded-* because Caddy (and Cloudflare in front of it) set them. */
  trustProxy: bool(process.env.TRUST_PROXY, true),
};

export const imagesDir = resolve(config.dataDir, 'images');
export const stateFile = resolve(config.dataDir, 'render-state.json');
