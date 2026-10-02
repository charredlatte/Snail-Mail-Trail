// Public club endpoints: search, detail, and the submission form.
import { query, queryOne } from '../db.js';
import { buildClubSearch, toClubJSON, PERIODS, SORTS } from '../search.js';
import { requireAuth } from '../auth.js';

const SORT_NAMES = Object.keys(SORTS);

/** "Ohio Postcard Swap!" -> "ohio-postcard-swap" */
function slugify(name) {
  return name.toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')     // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'club';
}

/** Append a counter when the slug is already taken: club, club-2, club-3. */
async function uniqueSlug(name) {
  const base = slugify(name);
  const { taken } = await queryOne(
    `SELECT count(*)::int AS taken FROM clubs WHERE slug = $1 OR slug LIKE $1 || '-%'`,
    [base],
  );
  return taken ? `${base}-${taken + 1}` : base;
}

const searchQuerySchema = {
  type: 'object',
  properties: {
    q:          { type: 'string', maxLength: 200 },
    country:    { type: 'string', minLength: 2, maxLength: 2 },
    region:     { type: 'string', maxLength: 100 },
    tags:       { type: 'string', maxLength: 300 },   // comma-separated slugs
    min_price:  { type: 'integer', minimum: 0 },      // cents per month
    max_price:  { type: 'integer', minimum: 0 },
    period:     { type: 'string', enum: PERIODS },
    lat:        { type: 'number', minimum: -90,  maximum: 90 },
    lng:        { type: 'number', minimum: -180, maximum: 180 },
    radius_km:  { type: 'number', exclusiveMinimum: 0, maximum: 20000 },
    sort:       { type: 'string', enum: SORT_NAMES, default: 'relevance' },
    page:       { type: 'integer', minimum: 1, default: 1 },
    per_page:   { type: 'integer', minimum: 1, maximum: 100, default: 24 },
  },
};

const submitBodySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name:            { type: 'string', minLength: 2,  maxLength: 120 },
    description:     { type: 'string', maxLength: 4000, default: '' },
    url:             { type: 'string', maxLength: 500 },
    price_cents:     { type: 'integer', minimum: 0, maximum: 100_000_000, default: 0 },
    price_currency:  { type: 'string', minLength: 3, maxLength: 3, default: 'USD' },
    price_period:    { type: 'string', enum: PERIODS, default: 'monthly' },
    country_code:    { type: 'string', minLength: 2, maxLength: 2 },
    region:          { type: 'string', maxLength: 100 },
    city:            { type: 'string', maxLength: 100 },
    lat:             { type: 'number', minimum: -90,  maximum: 90 },
    lng:             { type: 'number', minimum: -180, maximum: 180 },
    ships_worldwide: { type: 'boolean', default: false },
    tags:            { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 50 } },
  },
};

export default async function clubRoutes(app) {
  // --- search -------------------------------------------------------------
  app.get('/api/clubs', { schema: { querystring: searchQuerySchema } }, async (request) => {
    const p = request.query;

    // A radius search needs all three of lat/lng/radius_km; anything less is a
    // half-filled form, so ignore the geo filter rather than guessing.
    const hasGeo = p.lat != null && p.lng != null && p.radius_km != null;

    const { text, params } = buildClubSearch({
      q: p.q?.trim() || undefined,
      country: p.country,
      region: p.region,
      tags: p.tags?.split(',').map((t) => t.trim()).filter(Boolean),
      minPrice: p.min_price,
      maxPrice: p.max_price,
      period: p.period,
      lat: hasGeo ? p.lat : undefined,
      lng: hasGeo ? p.lng : undefined,
      radiusKm: hasGeo ? p.radius_km : undefined,
      sort: p.sort,
      page: p.page,
      perPage: p.per_page,
    });

    const rows = await query(text, params);
    const total = rows.length ? Number(rows[0].total_count) : 0;

    return {
      data: rows.map(toClubJSON),
      meta: {
        total,
        page: p.page,
        per_page: p.per_page,
        pages: Math.ceil(total / p.per_page),
      },
    };
  });

  // --- facet values for the filter UI -------------------------------------
  // Lets the front end build its dropdowns from real data instead of a
  // hardcoded list that drifts out of date.
  app.get('/api/filters', async () => {
    const [countries, regions, tags, price] = await Promise.all([
      query(`SELECT country_code, COUNT(*)::int AS count FROM clubs
              WHERE status = 'approved' AND country_code IS NOT NULL
              GROUP BY country_code ORDER BY count DESC, country_code`),
      query(`SELECT country_code, region, COUNT(*)::int AS count FROM clubs
              WHERE status = 'approved' AND region IS NOT NULL
              GROUP BY country_code, region ORDER BY country_code, region`),
      query(`SELECT t.slug, t.name, COUNT(ct.club_id)::int AS count
               FROM tags t
               LEFT JOIN club_tags ct ON ct.tag_id = t.id
               LEFT JOIN clubs c ON c.id = ct.club_id AND c.status = 'approved'
              GROUP BY t.slug, t.name ORDER BY count DESC, t.name`),
      // USD, to match what the min_price/max_price filters actually compare.
      queryOne(`SELECT COALESCE(MIN(usd_monthly_cents), 0)::int AS min_cents,
                       COALESCE(MAX(usd_monthly_cents), 0)::int AS max_cents
                  FROM clubs WHERE status = 'approved'`),
    ]);
    return { countries, regions, tags, price, periods: PERIODS };
  });

  // --- detail -------------------------------------------------------------
  app.get('/api/clubs/:slug', async (request, reply) => {
    const row = await queryOne(
      `SELECT c.*, COALESCE((
                SELECT json_agg(json_build_object('slug', t.slug, 'name', t.name) ORDER BY t.name)
                  FROM club_tags ct JOIN tags t ON t.id = ct.tag_id
                 WHERE ct.club_id = c.id), '[]'::json) AS tags
         FROM clubs c
        WHERE c.slug = $1 AND c.status = 'approved'`,
      [request.params.slug],
    );
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'No such club.' });
    return { data: toClubJSON(row) };
  });

  // --- submission form ----------------------------------------------------
  // Signed-in users only, and everything lands as 'pending' for review. That
  // combination is what keeps the directory from filling up with spam.
  app.post('/api/clubs', {
    schema: { body: submitBodySchema },
    preHandler: requireAuth,
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const b = request.body;

    // Only allow links people can actually click. Rejecting javascript: and
    // data: here means the front end never has to sanitise this field.
    if (b.url) {
      let parsed;
      try { parsed = new URL(b.url); } catch { parsed = null; }
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
        return reply.code(400).send({
          error: 'invalid_url', message: 'Website must be an http(s) link.',
        });
      }
    }

    const slug = await uniqueSlug(b.name);
    const club = await queryOne(
      `INSERT INTO clubs (slug, name, description, url, price_cents, price_currency,
                          price_period, country_code, region, city, lat, lng,
                          ships_worldwide, status, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14)
       RETURNING *`,
      [slug, b.name, b.description ?? '', b.url ?? null, b.price_cents ?? 0,
       (b.price_currency ?? 'USD').toUpperCase(), b.price_period ?? 'monthly',
       b.country_code?.toUpperCase() ?? null, b.region ?? null, b.city ?? null,
       b.lat ?? null, b.lng ?? null, b.ships_worldwide ?? false, request.user.id],
    );

    if (b.tags?.length) await setClubTags(club.id, b.tags);

    return reply.code(201).send({
      data: toClubJSON({ ...club, tags: [] }),
      message: 'Thanks! Your club is queued for review.',
    });
  });

  // --- a member's own submissions, in any status ---------------------------
  app.get('/api/me/submissions', { preHandler: requireAuth }, async (request) => {
    const rows = await query(
      `SELECT c.*, '[]'::json AS tags FROM clubs c
        WHERE c.submitted_by = $1 ORDER BY c.created_at DESC`,
      [request.user.id],
    );
    return {
      data: rows.map((r) => ({
        ...toClubJSON(r), status: r.status, reject_reason: r.reject_reason,
      })),
    };
  });
}

/** Replace a club's tags, creating any that do not exist yet. */
export async function setClubTags(clubId, tagNames) {
  const slugs = [...new Set(tagNames.map(slugify))].filter(Boolean);
  await query(`DELETE FROM club_tags WHERE club_id = $1`, [clubId]);
  if (!slugs.length) return;

  // ON CONFLICT DO NOTHING then re-select, so two people submitting the same new
  // tag at the same time cannot collide on the unique index.
  await query(
    `INSERT INTO tags (slug, name)
     SELECT s, initcap(replace(s, '-', ' ')) FROM unnest($1::text[]) AS s
     ON CONFLICT (slug) DO NOTHING`,
    [slugs],
  );
  await query(
    `INSERT INTO club_tags (club_id, tag_id)
     SELECT $1, id FROM tags WHERE slug = ANY($2)
     ON CONFLICT DO NOTHING`,
    [clubId, slugs],
  );
}
