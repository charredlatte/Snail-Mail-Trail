// Builds the club search query.
//
// Kept separate from the route handler so the query logic can be read (and
// tested) on its own. Every user-supplied value becomes a bound parameter --
// there is no string interpolation of input anywhere in this file.

// The vocabularies the API accepts. Defined here, next to the SQL that uses
// them, and imported by the route schemas so the two can never drift apart.
export const PERIODS = ['free', 'monthly', 'quarterly', 'yearly', 'one_time', 'per_swap'];

const EARTH_RADIUS_KM = 6371;
const KM_PER_DEGREE_LAT = 111.32;

// Distance in km between the caller's point and a club, computed in SQL so we
// can sort and paginate by it correctly. LEAST/GREATEST clamp the value into
// acos()'s legal domain -- floating point drift can otherwise push it just past
// 1 and raise a math error.
const HAVERSINE_SQL = (latParam, lngParam) => `
  (${EARTH_RADIUS_KM} * acos(LEAST(1, GREATEST(-1,
      sin(radians($${latParam})) * sin(radians(c.lat)) +
      cos(radians($${latParam})) * cos(radians(c.lat)) *
      cos(radians(c.lng) - radians($${lngParam}))
  ))))`;

export const SORTS = {
  relevance:  'rank DESC NULLS LAST, c.name ASC',
  price_asc:  'c.usd_monthly_cents ASC, c.name ASC',
  price_desc: 'c.usd_monthly_cents DESC, c.name ASC',
  distance:   'distance_km ASC NULLS LAST, c.name ASC',
  newest:     'c.created_at DESC',
  name:       'c.name ASC',
};

/**
 * Turn validated query parameters into { text, params }.
 *
 * Filter semantics: values within the `tags` facet are OR'd together (a club
 * tagged either "postcard" or "zine" matches), while separate facets are AND'd
 * (tags AND country AND price). That is the convention faceted search UIs use.
 */
export function buildClubSearch(opts) {
  const {
    q, country, region, tags, minPrice, maxPrice, period,
    lat, lng, radiusKm, sort = 'relevance', page = 1, perPage = 24,
  } = opts;

  const params = [];
  const where = [`c.status = 'approved'`];
  const push = (value) => params.push(value);          // returns new length == $n

  // --- text ---------------------------------------------------------------
  // websearch_to_tsquery is the forgiving parser: it accepts anything a person
  // types ("cheap -expensive \"art mail\"") without raising a syntax error.
  let rankSelect = 'NULL::float AS rank';
  if (q) {
    const n = push(q);
    // `<%` is word_similarity, not plain similarity: it scores the query against
    // the best-matching word inside the name. Whole-string similarity would rate
    // "stationary" against "Portland Stationery Society" far too low to match,
    // because most of the name is unrelated to the search term.
    where.push(`(c.search_doc @@ websearch_to_tsquery('english', $${n}) OR $${n} <% c.name)`);
    // Combine phrase relevance with fuzzy name similarity so a near-miss spelling
    // still ranks sensibly instead of falling to the bottom.
    rankSelect = `(ts_rank(c.search_doc, websearch_to_tsquery('english', $${n}))
                   + word_similarity($${n}, c.name)) AS rank`;
  }

  // --- location facets ----------------------------------------------------
  // ships_worldwide clubs stay visible when someone filters by country: they
  // will post to that person regardless of where the club itself sits.
  if (country) {
    const n = push(country.toUpperCase());
    where.push(`(c.country_code = $${n} OR c.ships_worldwide)`);
  }
  if (region) {
    const n = push(region);
    where.push(`lower(c.region) = lower($${n})`);
  }

  // --- tags ---------------------------------------------------------------
  if (tags?.length) {
    const n = push(tags);
    where.push(`EXISTS (
      SELECT 1 FROM club_tags ct JOIN tags t ON t.id = ct.tag_id
       WHERE ct.club_id = c.id AND t.slug = ANY($${n}))`);
  }

  // --- price --------------------------------------------------------------
  // Always usd_monthly_cents, never monthly_cents. The USD column is normalised
  // for both billing period and currency, so "under $20/month" compares a
  // yearly GBP club against a monthly USD one honestly. Filtering on the native
  // column would treat GBP 14 as USD 14.
  if (minPrice != null) where.push(`c.usd_monthly_cents >= $${push(minPrice)}`);
  if (maxPrice != null) where.push(`c.usd_monthly_cents <= $${push(maxPrice)}`);
  if (period)          where.push(`c.price_period      =  $${push(period)}`);

  // --- radius -------------------------------------------------------------
  let distanceSelect = 'NULL::float AS distance_km';
  const hasGeo = lat != null && lng != null && radiusKm != null;
  if (hasGeo) {
    const latN = push(lat);
    const lngN = push(lng);
    distanceSelect = `${HAVERSINE_SQL(latN, lngN)} AS distance_km`;

    // Cheap bounding box first: it uses the (lat, lng) index and throws away
    // most of the table before we pay for any trigonometry. The haversine test
    // below then trims the box's corners down to a true circle.
    const dLat = radiusKm / KM_PER_DEGREE_LAT;
    // Longitude degrees shrink towards the poles; clamp so we never divide by
    // ~0 and produce an infinite box.
    const dLng = radiusKm / (KM_PER_DEGREE_LAT * Math.max(0.01, Math.cos(lat * Math.PI / 180)));

    where.push(`c.lat BETWEEN $${push(lat - dLat)} AND $${push(lat + dLat)}`);
    where.push(`c.lng BETWEEN $${push(lng - dLng)} AND $${push(lng + dLng)}`);
    where.push(`${HAVERSINE_SQL(latN, lngN)} <= $${push(radiusKm)}`);
  }

  // Asking to sort by distance without giving a point is meaningless; fall back
  // rather than erroring, so a front end can leave sort=distance selected while
  // the user is still picking a location.
  const orderBy = SORTS[hasGeo || sort !== 'distance' ? sort : 'relevance'] ?? SORTS.relevance;

  const limit  = push(perPage);
  const offset = push((page - 1) * perPage);

  // COUNT(*) OVER () gives us the total for pagination in the same round trip
  // rather than running a second COUNT query.
  const text = `
    SELECT c.id, c.slug, c.name, c.description, c.url,
           c.price_cents, c.price_currency, c.price_period,
           c.monthly_cents, c.usd_monthly_cents, c.fx_to_usd,
           c.country_code, c.region, c.city, c.lat, c.lng, c.ships_worldwide,
           c.created_at,
           ${rankSelect},
           ${distanceSelect},
           COALESCE((
             SELECT json_agg(json_build_object('slug', t.slug, 'name', t.name)
                             ORDER BY t.name)
               FROM club_tags ct JOIN tags t ON t.id = ct.tag_id
              WHERE ct.club_id = c.id
           ), '[]'::json) AS tags,
           COUNT(*) OVER () AS total_count
      FROM clubs c
     WHERE ${where.join('\n       AND ')}
     ORDER BY ${orderBy}
     LIMIT $${limit} OFFSET $${offset}`;

  return { text, params };
}

/** Shape a database row into the JSON the front end consumes. */
export function toClubJSON(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    url: row.url,
    price: {
      // cents is always the amount x100 in the club's own currency, including
      // for zero-decimal currencies: JPY 2500 is stored as 250000.
      cents: row.price_cents,
      currency: row.price_currency,
      period: row.price_period,
      // Monthly equivalent in the club's own currency. For display.
      monthly_cents: row.monthly_cents,
      // Monthly equivalent in US cents. This is what the price filter compares,
      // so it is the figure to show when sorting or filtering by price.
      usd_monthly_cents: row.usd_monthly_cents,
      // null means no exchange rate has been recorded, so usd_monthly_cents
      // fell back to treating the amount as USD. Non-null for converted rows.
      fx_to_usd: row.fx_to_usd == null ? null : Number(row.fx_to_usd),
    },
    location: {
      country_code: row.country_code,
      region: row.region,
      city: row.city,
      lat: row.lat,
      lng: row.lng,
      ships_worldwide: row.ships_worldwide,
    },
    tags: row.tags ?? [],
    // Only present on a radius search. Rounded -- sub-100m precision is noise
    // for "how far is this club".
    distance_km: row.distance_km == null ? null : Math.round(row.distance_km * 10) / 10,
    created_at: row.created_at,
  };
}
