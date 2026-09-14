#!/usr/bin/env node
// Bulk-load clubs from a CSV file.
//
//   node scripts/import-clubs.js clubs.csv
//   node scripts/import-clubs.js clubs.csv --geocode    look up missing lat/lng
//   node scripts/import-clubs.js clubs.csv --approved   publish immediately
//
// Columns (header row required; only `name` is mandatory):
//   name, description, url, price, currency, period, country, region, city,
//   lat, lng, ships_worldwide, tags
//
// `price` is in whole currency units (12.50 means $12.50) because that is what
// you will have typed in a spreadsheet. It is converted to cents on the way in.
// `tags` is semicolon-separated: postcard;beginner
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pool, queryOne } from '../src/db.js';
import { setClubTags } from '../src/routes/clubs.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { geocode: { type: 'boolean' }, approved: { type: 'boolean' } },
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

const rows = parseCSV(await readFile(file, 'utf8'));
console.log(`read ${rows.length} rows from ${file}`);

let created = 0, updated = 0, skipped = 0;

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
  const priceCents = r.price ? Math.round(Number(r.price) * 100) : 0;

  const club = await queryOne(
    `INSERT INTO clubs (slug, name, description, url, price_cents, price_currency,
                        price_period, country_code, region, city, lat, lng,
                        ships_worldwide, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description, url = EXCLUDED.url,
       price_cents = EXCLUDED.price_cents, price_currency = EXCLUDED.price_currency,
       price_period = EXCLUDED.price_period, country_code = EXCLUDED.country_code,
       region = EXCLUDED.region, city = EXCLUDED.city,
       lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       ships_worldwide = EXCLUDED.ships_worldwide
     RETURNING id, (xmax = 0) AS inserted`,
    [
      slugify(r.name) || `club-${Date.now()}`,
      r.name, r.description ?? '', r.url || null,
      Number.isFinite(priceCents) ? priceCents : 0,
      (r.currency || 'USD').toUpperCase(),
      r.period || 'monthly',
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
console.log(values.approved ? 'imported as approved' : 'imported as pending - approve in the admin queue');
await pool.end();
