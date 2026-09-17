#!/usr/bin/env node
/**
 * Render the chart images once, from the command line.
 *
 *   npm run shoot                      render against a locally running server
 *   npm run shoot -- --url https://... render against any deployment
 *
 * The server does this on its own schedule; this entry point exists for
 * debugging a rendering problem without waiting for the timer, and for anyone
 * who would rather drive the renderer from their own cron.
 */
import { config } from './config.js';
import { fetchAreaQnh, revisionOf } from './bom.js';
import { renderIfChanged } from './screenshots.js';

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const baseUrl = flag('url')
  ?? config.screenshots.baseUrl
  ?? `http://127.0.0.1:${config.port}`;
const force = args.includes('--force');

const forecast = await fetchAreaQnh({ timeoutMs: config.bom.timeoutMs }).catch(err => {
  console.error(`Could not read the forecast: ${err.message}`);
  return null;
});

const result = await renderIfChanged(baseUrl, forecast ? revisionOf(forecast) : null, { force });
console.log(result.rendered
  ? `rendered ${result.images.length} image(s) (${result.reason})`
  : 'images already current; pass --force to render anyway');
