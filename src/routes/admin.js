// Moderation queue. Every route here is behind requireAdmin.
import { query, queryOne } from '../db.js';
import { requireAdmin } from '../auth.js';
import { toClubJSON, PERIODS } from '../search.js';
import { setClubTags } from './clubs.js';

export default async function adminRoutes(app) {
  // Everything submitted, filterable by status. Defaults to the review queue.
  app.get('/api/admin/clubs', {
    preHandler: requireAdmin,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status:   { type: 'string', enum: ['pending', 'approved', 'rejected'],
                      default: 'pending' },
          page:     { type: 'integer', minimum: 1, default: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
  }, async (request) => {
    const { status, page, per_page } = request.query;
    const rows = await query(
      `SELECT c.*, u.email AS submitter_email,
              (c.price_currency <> 'USD' AND c.fx_to_usd IS NULL
               AND c.price_period <> 'free') AS needs_fx_rate,
              COALESCE((SELECT json_agg(json_build_object('slug', t.slug, 'name', t.name))
                          FROM club_tags ct JOIN tags t ON t.id = ct.tag_id
                         WHERE ct.club_id = c.id), '[]'::json) AS tags,
              COUNT(*) OVER () AS total_count
         FROM clubs c
         LEFT JOIN users u ON u.id = c.submitted_by
        WHERE c.status = $1
        ORDER BY c.created_at DESC
        LIMIT $2 OFFSET $3`,
      [status, per_page, (page - 1) * per_page],
    );
    const total = rows.length ? Number(rows[0].total_count) : 0;
    return {
      data: rows.map((r) => ({
        ...toClubJSON(r), status: r.status, submitter_email: r.submitter_email,
        // true = priced in a foreign currency with no exchange rate recorded,
        // so its USD price is wrong until you set fx_to_usd.
        needs_fx_rate: r.needs_fx_rate,
      })),
      meta: { total, page, per_page, pages: Math.ceil(total / per_page) },
    };
  });

  // Approve, reject, or correct a submission. Admins routinely need to fix a
  // typo or add coordinates before approving, so edits and status changes share
  // one endpoint rather than forcing two round trips.
  app.patch('/api/admin/clubs/:id', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        properties: {
          status:          { type: 'string', enum: ['pending', 'approved', 'rejected'] },
          reject_reason:   { type: 'string', maxLength: 500 },
          name:            { type: 'string', minLength: 2, maxLength: 120 },
          description:     { type: 'string', maxLength: 4000 },
          url:             { type: 'string', maxLength: 500 },
          price_cents:     { type: 'integer', minimum: 0 },
          price_currency:  { type: 'string', minLength: 3, maxLength: 3 },
          price_period:    { type: 'string', enum: PERIODS },
          fx_to_usd:       { type: 'number', exclusiveMinimum: 0 },
          country_code:    { type: 'string', minLength: 2, maxLength: 2 },
          region:          { type: 'string', maxLength: 100 },
          city:            { type: 'string', maxLength: 100 },
          lat:             { type: 'number', minimum: -90,  maximum: 90 },
          lng:             { type: 'number', minimum: -180, maximum: 180 },
          ships_worldwide: { type: 'boolean' },
          tags:            { type: 'array', maxItems: 10,
                             items: { type: 'string', maxLength: 50 } },
        },
      },
    },
  }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'bad_id', message: 'Club id must be a number.' });
    }

    const { tags, ...fields } = request.body;

    // Column names come from this fixed list, never from the request body, so
    // the dynamic SET clause cannot be steered by a caller.
    const ALLOWED = ['status', 'reject_reason', 'name', 'description', 'url',
      'price_cents', 'price_currency', 'price_period', 'fx_to_usd',
      'country_code', 'region', 'city', 'lat', 'lng', 'ships_worldwide'];

    const sets = [];
    const params = [];
    for (const col of ALLOWED) {
      if (fields[col] === undefined) continue;
      let value = fields[col];
      if (col === 'country_code'   && value) value = value.toUpperCase();
      if (col === 'price_currency' && value) value = value.toUpperCase();
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    }

    if (!sets.length && !tags) {
      return reply.code(400).send({ error: 'no_changes', message: 'Nothing to update.' });
    }

    let club;
    if (sets.length) {
      params.push(id);
      club = await queryOne(
        `UPDATE clubs SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
    } else {
      club = await queryOne(`SELECT * FROM clubs WHERE id = $1`, [id]);
    }

    if (!club) return reply.code(404).send({ error: 'not_found', message: 'No such club.' });
    if (tags) await setClubTags(id, tags);

    return { data: { ...toClubJSON({ ...club, tags: [] }), status: club.status } };
  });

  app.delete('/api/admin/clubs/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'bad_id', message: 'Club id must be a number.' });
    }
    const gone = await queryOne(`DELETE FROM clubs WHERE id = $1 RETURNING id`, [id]);
    if (!gone) return reply.code(404).send({ error: 'not_found', message: 'No such club.' });
    return { ok: true };
  });
}
