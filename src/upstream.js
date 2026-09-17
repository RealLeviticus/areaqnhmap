/**
 * Keeps a single cached copy of each upstream feed, refreshed on a timer.
 *
 * This is deliberately a *push* cache rather than fetch-on-request. BOM issues
 * Area QNH eight times a day; there is no reason for a visitor's page load to
 * ever wait on bom.gov.au, and no reason for BOM to see more than one request
 * per refresh interval no matter how many people are looking at the map.
 *
 * The last good value is kept and served if an upstream refresh fails, so a BOM
 * outage degrades to "slightly stale" rather than "broken".
 */

export class Feed {
  /**
   * @param {object} opts
   * @param {string} opts.name        label used in logs
   * @param {() => Promise<any>} opts.load  fetches and parses the upstream
   * @param {number} opts.refreshMs   how often to refresh in the background
   * @param {number} [opts.staleMs]   how long a stale value may still be served
   */
  constructor({ name, load, refreshMs, staleMs = Infinity }) {
    this.name = name;
    this.load = load;
    this.refreshMs = refreshMs;
    this.staleMs = staleMs;

    this.value = null;
    this.fetchedAt = 0;
    this.lastError = null;
    this.lastErrorAt = 0;
    this.timer = null;
    this.inFlight = null;
  }

  get age() {
    return this.fetchedAt ? Date.now() - this.fetchedAt : Infinity;
  }

  get isStale() {
    return this.age > this.staleMs;
  }

  /** Refresh now. Concurrent callers share one upstream request. */
  refresh() {
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      try {
        const value = await this.load();
        this.value = value;
        this.fetchedAt = Date.now();
        this.lastError = null;
        return value;
      } catch (err) {
        this.lastError = err;
        this.lastErrorAt = Date.now();
        // A failed refresh is not fatal: we keep serving the previous value.
        console.error(`[${this.name}] refresh failed: ${err.message}`);
        throw err;
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  /**
   * The current value, fetching once if we have never succeeded.
   * Never throws once a value has been obtained at least once.
   */
  async get() {
    if (this.value === null) {
      await this.refresh().catch(() => {});
    }
    return this.value;
  }

  start() {
    if (this.timer) return;
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.refreshMs);
    // Do not hold the process open just for the refresh timer.
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return {
      ok: this.value !== null && !this.isStale,
      hasValue: this.value !== null,
      ageSeconds: this.fetchedAt ? Math.round(this.age / 1000) : null,
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      stale: this.isStale,
      lastError: this.lastError ? this.lastError.message : null,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
    };
  }
}

/**
 * Fetches the vatSys Australian airspace dataset.
 *
 * The map uses it to resolve the navaid/waypoint identifiers BOM names in
 * subdivision clauses ("N OF YRLL/YARY") to coordinates. It is a ~10 MB XML
 * file that changes once per AIRAC cycle, so it is fetched rarely and held in
 * memory rather than proxied per request.
 */
export async function fetchAirspace({ url, timeoutMs, fetchImpl = fetch }) {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`airspace source responded ${res.status} ${res.statusText}`);

  const xml = await res.text();
  if (!xml.includes('<Airspace')) {
    throw new Error('airspace source did not return an Airspace document');
  }
  return xml;
}
