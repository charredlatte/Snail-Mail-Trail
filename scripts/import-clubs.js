#!/usr/bin/env node
// Bulk-load clubs from a CSV file.
//
//   node scripts/import-clubs.js clubs.csv
//   node scripts/import-clubs.js clubs.csv --geocode    look up missing lat/lng
//   node scripts/import-clubs.js clubs.csv --approved   publish immediately
//
// Columns (header row required; only `name` is mandatory):
//   name, description, url, price, currency, period, country, region, city,
//   lat, lng, ships_worldwide, tags, fx_to_usd
//
// `price` is in whole currency units (12.50 means $12.50) because that is what
// you will have typed in a spreadsheet. It is converted to cents on the way in.
// `tags` is semicolon-separated: postcard;beginner
//
// Any row in a currency other than USD gets an exchange rate so that price
// filtering compares like with like. Rates are looked up once per run; set a
// row's `fx_to_usd` column to pin a specific rate instead.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pool, queryOne } from '../src/db.js';
import { setClubTags } from '../src/routes/clubs.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    geocode:  { type: 'boolean' },
    approved: { type: 'boolean' },
    'no-fx':  { type: 'boolean' },   // skip the rate lookup entirely
  },
});

const file = positionals[0];
if (!file) {
  console.error('usage: node scripts/import-clubs.js <file.csv> [--geocode] [--approved]');
  process.exit(1);
}

/**
 * Minimal RFC4180 CSV reader: handles quoted fields, escaped quotes ("") and
 * newlines inside quotes. A dependency would buy us encoding edge cases we do
 * not have; this is the whole format.
 */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // "" -> literal quote
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') continue;
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

// Nominatim is OpenStreetMap's free geocoder. Its usage policy requires an
// identifying User-Agent and at most one request per second -- both honoured
// below. For a one-off import of a few hundred rows that is plenty.
const geocodeCache = new Map();
async function geocode(parts) {
  const q = parts.filter(Boolean).join(', ');
  if (!q) return null;
  if (geocodeCache.has(q)) return geocodeCache.get(q);

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');

  const contact = process.env.GEOCODER_CONTACT || 'unset@example.com';
  let result = null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': `snail-mail-trail-import/0.1 (${contact})` },
    });
    if (res.ok) {
      const [hit] = await res.json();
      if (hit) result = { lat: Number(hit.lat), lng: Number(hit.lon) };
    } else {
      console.warn(`  geocoder returned ${res.status} for "${q}"`);
    }
  } catch (err) {
    console.warn(`  geocode failed for "${q}": ${err.message}`);
  }

  geocodeCache.set(q, result);
  await new Promise((r) => setTimeout(r, 1100));    // rate limit
  return result;
}

const slugify = (s) => s.toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * USD per one unit of each currency, e.g. { GBP: 1.32, JPY: 0.0063 }.
 *
 * Frankfurter publishes European Central Bank rates as USD -> currency, so each
 * one is inverted to get the USD-per-unit direction the database stores. One
 * request covers every currency. Free, no API key, ~30 major currencies.
 */
async function fetchUsdRates() {
  if (values['no-fx']) return {};
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { date, rates } = await res.json();
    const usdPerUnit = Object.fromEntries(
      Object.entries(rates).map(([code, perUsd]) => [code, 1 / perUsd]),
    );
    usdPerUnit.USD = 1;
    console.log(`exchange rates loaded (ECB, ${date})`);
    return usdPerUnit;
  } catch (err) {
    // Not fatal: USD rows are unaffected, and anything else is reported below
    // so you know which listings need a rate set by hand.
    console.warn(`exchange rate lookup failed (${err.message}); non-USD rows ` +
                 `will be imported without a rate`);
    return {};
  }
}

const rows = parseCSV(await readFile(file, 'utf8'));
console.log(`read ${rows.length} rows from ${file}`);

const usdRates = rows.some((r) => (r.currency || 'USD').toUpperCase() !== 'USD')
  ? await fetchUsdRates()
  : { USD: 1 };

let created = 0, updated = 0, skipped = 0;
const noRate = [];

for (const [i, r] of rows.entries()) {
  if (!r.name) { console.warn(`row ${i + 2}: no name, skipped`); skipped++; continue; }

  let lat = r.lat ? Number(r.lat) : null;
  let lng = r.lng ? Number(r.lng) : null;

  if (values.geocode && (lat == null || Number.isNaN(lat))) {
    const hit = await geocode([r.city, r.region, r.country]);
    if (hit) { lat = hit.lat; lng = hit.lng; console.log(`  geocoded ${r.name}`); }
  }

  // Money via round() on a float is fine at these magnitudes and keeps the
  // spreadsheet-friendly "12.50" input format.
  //
  // Note this is always amount x100, including for zero-decimal currencies:
  // JPY 2500 is stored as 250000. The exchange rate is scaled to match, so the
  // converted figure stays correct.
  const priceCents = r.price ? Math.round(Number(r.price) * 100) : 0;

  // An explicit column wins; otherwise use the looked-up rate. Free listings
  // need no rate -- zero converts to zero in any currency.
  const currency = (r.currency || 'USD').toUpperCase();
  let fxToUsd = r.fx_to_usd ? Number(r.fx_to_usd) : usdRates[currency] ?? null;
  if (!Number.isFinite(fxToUsd) || fxToUsd <= 0) fxToUsd = null;
  if (fxToUsd == null && currency !== 'USD' && r.period !== 'free') {
    noRate.push(`${r.name} (${currency})`);
  }

  const club = await queryOne(
    `INSERT INTO clubs (slug, name, description, url, price_cents, price_currency,
                        price_period, fx_to_usd, country_code, region, city,
                        lat, lng, ships_worldwide, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description, url = EXCLUDED.url,
       price_cents = EXCLUDED.price_cents, price_currency = EXCLUDED.price_currency,
       price_period = EXCLUDED.price_period, fx_to_usd = EXCLUDED.fx_to_usd,
       country_code = EXCLUDED.country_code,
       region = EXCLUDED.region, city = EXCLUDED.city,
       lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       ships_worldwide = EXCLUDED.ships_worldwide
     RETURNING id, (xmax = 0) AS inserted`,
    [
      slugify(r.name) || `club-${Date.now()}`,
      r.name, r.description ?? '', r.url || null,
      Number.isFinite(priceCents) ? priceCents : 0,
      currency,
      r.period || 'monthly',
      fxToUsd,
      r.country ? r.country.toUpperCase().slice(0, 2) : null,
      r.region || null, r.city || null,
      Number.isFinite(lat) ? lat : null,
      Number.isFinite(lng) ? lng : null,
      ['true', 'yes', '1'].includes((r.ships_worldwide || '').toLowerCase()),
      values.approved ? 'approved' : 'pending',
    ],
  );

  if (r.tags) await setClubTags(club.id, r.tags.split(';').map((t) => t.trim()).filter(Boolean));
  club.inserted ? created++ : updated++;
}

console.log(`created ${created}, updated ${updated}, skipped ${skipped}`);
if (noRate.length) {
  console.warn(`\n${noRate.length} listing(s) have no exchange rate, so their ` +
    `USD price is wrong until you set one:`);
  for (const n of noRate) console.warn(`  - ${n}`);
  console.warn(`Set fx_to_usd on these rows, or fix them in the admin queue.`);
}
console.log(values.approved ? 'imported as approved' : 'imported as pending - approve in the admin queue');
await pool.end();
