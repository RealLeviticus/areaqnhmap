/**
 * Parses the Bureau of Meteorology's public Area QNH page into structured JSON.
 *
 * https://www.bom.gov.au/aviation/forecasts/area-qnh/
 *
 * BOM also publishes a *graphical* Area QNH chart, but it lives behind
 * https://www.bom.gov.au/products/reg/aviation/area-qnh/ which returns 401 to
 * anyone without a registered-user login, and the raw IDY400xx text products
 * aren't served publicly either. The HTML page below is the only public source,
 * which is the whole reason this project exists.
 *
 * The markup is stable and well structured -- one div per state, each carrying
 * its own Valid/Issued stamps and a <dl> of area -> forecast. Parsing that
 * structure (rather than flattening the page to text) is what lets us keep
 * per-state issue times, which matters because BOM amends states individually.
 */
import * as cheerio from 'cheerio';

export const BOM_URL = 'https://www.bom.gov.au/aviation/forecasts/area-qnh/';

/** Bumped only when the request shape changes; see fetchAreaQnh for why it is bare. */
const USER_AGENT = 'areaqnhmap/2.0';

/** The tab ids BOM uses, in the order it presents them. */
const STATES = {
  nsw: 'New South Wales',
  vic: 'Victoria',
  qld: 'Queensland',
  sa: 'South Australia',
  wa: 'Western Australia',
  tas: 'Tasmania',
  nt: 'Northern Territory',
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * "1204 UTC 17 September 2026" -> Date.
 * Returns null rather than an Invalid Date so callers can just check for null.
 */
function parseStamp(text) {
  const m = /(\d{2})(\d{2})\s*UTC\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(text ?? '');
  if (!m) return null;
  const [, hh, mm, day, monthName, year] = m;
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (month < 0) return null;
  return new Date(Date.UTC(+year, month, +day, +hh, +mm));
}

/**
 * "1300 UTC - 1600 UTC 17 September 2026" -> { from, to }.
 * BOM prints the date once, at the end. A validity that starts at 2200 and ends
 * at 0100 belongs to the *next* day, so roll the end date forward when it would
 * otherwise land before the start.
 */
function parseValidity(text) {
  const re = /(\d{2})(\d{2})\s*UTC\s*(?:-|to|–)\s*(\d{2})(\d{2})\s*UTC\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i;
  const m = re.exec(text ?? '');
  if (!m) return { from: null, to: null };
  const [, fh, fm, th, tm, day, monthName, year] = m;
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (month < 0) return { from: null, to: null };

  const from = new Date(Date.UTC(+year, month, +day, +fh, +fm));
  const to = new Date(Date.UTC(+year, month, +day, +th, +tm));
  if (to <= from) to.setUTCDate(to.getUTCDate() + 1);
  return { from, to };
}

/**
 * Splits one area's forecast into ordered rules.
 *
 * BOM writes subdivisions as comma-separated clauses in priority order, most
 * specific first, e.g.
 *
 *   SE OF YGTN/YCKN 1022, BETWEEN YCOE/YCRY AND YGTN/YCKN 1019, REST 1016
 *
 * Each clause is matched on its own. The previous implementation ran three
 * global regexes across the whole string and re-sorted by match offset, which
 * mis-attributed clauses containing both a direction and a BETWEEN.
 */
export function parseRules(forecast) {
  const clauses = forecast
    .split(/\s*,\s*|\n+/)
    .map(c => c.trim())
    .filter(Boolean);

  const rules = [];
  for (const clause of clauses) {
    let m;

    if ((m = /^BETWEEN\s+(.+?)\s+AND\s+(.+?)\s+(\d{3,4})$/i.exec(clause))) {
      rules.push({ type: 'between', lhs: m[1].trim(), rhs: m[2].trim(), qnh: +m[3] });
      continue;
    }
    if ((m = /^(NW|NE|SW|SE|N|S|E|W)\s+OF\s+(.+?)\s+(\d{3,4})$/i.exec(clause))) {
      rules.push({ type: 'of', dir: m[1].toUpperCase(), lhs: m[2].trim(), qnh: +m[3] });
      continue;
    }
    if ((m = /^REST\s+(\d{3,4})$/i.exec(clause))) {
      rules.push({ type: 'rest', qnh: +m[1] });
      continue;
    }
    if ((m = /^(\d{3,4})$/.exec(clause))) {
      rules.push({ type: 'all', qnh: +m[1] });
      continue;
    }

    // Anything we don't recognise is kept so the UI can surface it rather than
    // silently dropping a forecast the Bureau has actually issued.
    rules.push({ type: 'unparsed', text: clause });
  }
  return rules;
}

/** Turn the <dd> markup into plain text, keeping <br> as a line break. */
function forecastText($, dd) {
  const html = $(dd).html() ?? '';
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n');
  return cheerio.load(`<div>${withBreaks}</div>`)('div')
    .text()
    .replace(/ /g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * @param {string} html raw BOM page
 * @returns parsed forecast; throws if the page shape has changed
 */
export function parseAreaQnh(html) {
  const $ = cheerio.load(html);

  const states = {};
  const areas = {};

  for (const [id, name] of Object.entries(STATES)) {
    const block = $(`#${id}`);
    if (!block.length) continue;

    const validText = block.find('.aq-date.valid').first().text().replace(/\s+/g, ' ').trim();
    const issuedText = block.find('.aq-date.issued').first().text().replace(/\s+/g, ' ').trim();
    const { from, to } = parseValidity(validText);
    const issued = parseStamp(issuedText);

    // BOM marks an out-of-cycle reissue by putting AMD in the validity line.
    const amended = /\bAMD\b/i.test(validText) || /\bAMD\b/i.test(issuedText);

    const areaCodes = [];
    const list = block.find('dl.aq-list').first();
    list.find('dt').each((_, dt) => {
      const label = $(dt).text().trim();
      const m = /^Area\s*(\d+)\s*:?$/i.exec(label);
      if (!m) return;

      const code = m[1];
      const forecast = forecastText($, $(dt).next('dd'));
      if (!forecast) return;

      const rules = parseRules(forecast);
      areas[code] = {
        area: code,
        state: id,
        forecast,
        rules,
        // Convenience for the common case of an undivided area.
        qnh: rules.length === 1 && rules[0].type === 'all' ? rules[0].qnh : null,
      };
      areaCodes.push(code);
    });

    states[id] = {
      id,
      name,
      areas: areaCodes,
      amended,
      validText,
      issuedText,
      validFrom: from ? from.toISOString() : null,
      validTo: to ? to.toISOString() : null,
      issued: issued ? issued.toISOString() : null,
    };
  }

  if (!Object.keys(areas).length) {
    throw new Error('BOM page contained no Area QNH entries; the page layout may have changed');
  }

  // Headline stamps for the whole country. States normally share one cycle, so
  // take the widest validity and the latest issue time.
  const issuedTimes = Object.values(states).map(s => s.issued).filter(Boolean).sort();
  const validFroms = Object.values(states).map(s => s.validFrom).filter(Boolean).sort();
  const validTos = Object.values(states).map(s => s.validTo).filter(Boolean).sort();

  return {
    source: BOM_URL,
    fetchedAt: new Date().toISOString(),
    issued: issuedTimes.at(-1) ?? null,
    validFrom: validFroms[0] ?? null,
    validTo: validTos.at(-1) ?? null,
    amended: Object.values(states).some(s => s.amended),
    states,
    areas,
  };
}

/**
 * A short string that changes exactly when the forecast changes.
 * Used to decide whether the rendered images are still current.
 */
export function revisionOf(forecast) {
  return Object.values(forecast.states)
    .map(s => `${s.id}:${s.issuedText}:${s.validText}`)
    .sort()
    .join('|');
}

export async function fetchAreaQnh({ timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(BOM_URL, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      // BOM's WAF rejects any User-Agent containing a URL (tested: a bare
      // product token is fine, the same token with "+https://..." returns 403),
      // so identify plainly rather than pretending to be a browser.
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-AU,en;q=0.9',
    },
  });

  if (!res.ok) throw new Error(`BOM responded ${res.status} ${res.statusText}`);
  return parseAreaQnh(await res.text());
}
