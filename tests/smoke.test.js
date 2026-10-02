// End-to-end tests against a real Postgres database.
//
//   TEST_DATABASE_URL=postgres://... npm test
//
// Uses Fastify's inject(), so the app is driven in-process with no port bound.
// The database is rebuilt from db/schema.sql and db/seed.sql on every run.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Must be set before src/db.js is imported, hence the dynamic imports below.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://snailmail:devpassword@127.0.0.1:5432/snailmail_test';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.LOG_LEVEL = 'silent';

const { pool } = await import('../src/db.js');
const { build } = await import('../src/server.js');
const { hashPassword } = await import('../src/auth.js');

let app;

before(async () => {
  await pool.query(await readFile(join(root, 'db', 'schema.sql'), 'utf8'));
  await pool.query('TRUNCATE clubs, tags, club_tags, users, sessions RESTART IDENTITY CASCADE');
  await pool.query(await readFile(join(root, 'db', 'seed.sql'), 'utf8'));
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, role)
     VALUES ('admin@test.local', $1, 'Admin', 'admin')`,
    [await hashPassword('admin-password-123')],
  );
  // Rate limiting off here: these tests register many accounts from one IP and
  // would otherwise throttle themselves. It gets its own test at the bottom.
  app = await build({ rateLimit: false });
});

after(async () => {
  await app?.close();
  await pool.end();
});

const get = (url, headers) => app.inject({ method: 'GET', url, headers });
const post = (url, payload, headers) =>
  app.inject({ method: 'POST', url, payload, headers });

/** Pull the session cookie out of a login/register response. */
const cookieFrom = (res) => {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.find((c) => c?.startsWith('smt_session=')).split(';')[0];
};

describe('health', () => {
  test('reports ok', async () => {
    const res = await get('/api/health');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });
});

describe('search', () => {
  test('returns approved clubs only', async () => {
    const res = await get('/api/clubs?per_page=100');
    assert.equal(res.statusCode, 200);
    const { data, meta } = res.json();
    assert.equal(meta.total, 12, 'seed has 12 approved clubs + 2 pending');
    assert.ok(!data.some((c) => c.slug === 'sample-pending-example'),
      'pending club must never appear in public search');
  });

  test('full-text search matches the description', async () => {
    const { data } = (await get('/api/clubs?q=zine')).json();
    assert.ok(data.some((c) => c.slug === 'sample-brooklyn-zine-post'));
  });

  test('fuzzy search survives a typo', async () => {
    // "stationary" is the common misspelling of "stationery".
    const { data } = (await get('/api/clubs?q=stationary')).json();
    assert.ok(data.length > 0, 'trigram matching should still find results');
  });

  test('price filter compares normalised monthly cost', async () => {
    // Portland is $90/yr = $7.50/mo, so it belongs under a $10/mo ceiling
    // even though its price_cents is 9000.
    const { data } = (await get('/api/clubs?max_price=1000&per_page=100')).json();
    const slugs = data.map((c) => c.slug);
    assert.ok(slugs.includes('sample-portland-stationery-society'),
      '$90/year must qualify under a $10/month filter');
    assert.ok(!slugs.includes('sample-melbourne-post-haste'),
      'AUD 18/month must not qualify under a $10/month filter');
  });

  test('price filter converts currency, not just billing period', async () => {
    // London is GBP 14/month. At ~1.27 USD per GBP that is ~$17.78/month, so a
    // $15 ceiling must exclude it -- even though the bare number 1400 would
    // slip under a 1500 cent limit if the filter ignored currency. This is the
    // assertion that fails if anything starts filtering on monthly_cents.
    const under = (await get('/api/clubs?max_price=1500&per_page=100')).json();
    assert.ok(!under.data.some((c) => c.slug === 'sample-london-letterbox-club'),
      'GBP 14/month is about $17.78 and must not pass a $15/month filter');

    const over = (await get('/api/clubs?max_price=1800&per_page=100')).json();
    assert.ok(over.data.some((c) => c.slug === 'sample-london-letterbox-club'),
      'GBP 14/month must pass a $18/month filter');
  });

  test('a cheap foreign club is not hidden by its large raw number', async () => {
    // Kyoto is JPY 30,000/year. The raw minor-unit figure is 3,000,000, but the
    // real cost is about $15.90/month, so a $20 ceiling must include it.
    const { data } = (await get('/api/clubs?max_price=2000&per_page=100')).json();
    assert.ok(data.some((c) => c.slug === 'sample-kyoto-tegami-circle'),
      'JPY 30000/year is about $16/month and must pass a $20/month filter');
  });

  test('price sort orders by USD, not by raw amount', async () => {
    const { data } = (await get('/api/clubs?sort=price_asc&per_page=100')).json();
    const usd = data.map((c) => c.price.usd_monthly_cents);
    assert.deepEqual(usd, [...usd].sort((a, b) => a - b),
      'sort=price_asc must be ascending in USD terms');
  });

  test('exposes both the native and converted price', async () => {
    const { data } = (await get('/api/clubs/sample-london-letterbox-club')).json();
    assert.equal(data.price.currency, 'GBP');
    assert.equal(data.price.monthly_cents, 1400, 'native monthly figure, GBP');
    assert.ok(data.price.usd_monthly_cents > 1700,
      'converted monthly figure, US cents');
    assert.equal(typeof data.price.fx_to_usd, 'number');
  });

  test('a free club converts to zero in any currency', async () => {
    const { data } = (await get('/api/clubs?max_price=0&per_page=100')).json();
    assert.ok(data.length >= 2, 'the free clubs must all be reachable at $0');
    for (const c of data) assert.equal(c.price.usd_monthly_cents, 0);
  });

  test('country filter also surfaces worldwide shippers', async () => {
    const { data } = (await get('/api/clubs?country=JP&per_page=100')).json();
    const slugs = data.map((c) => c.slug);
    assert.ok(slugs.includes('sample-kyoto-tegami-circle'), 'a JP club matches JP');
    assert.ok(slugs.includes('sample-london-letterbox-club'),
      'a worldwide shipper reaches Japan, so it must appear');
    assert.ok(!slugs.includes('sample-columbus-postcard-swap'),
      'a local Ohio club does not serve Japan');
  });

  test('region filter is case-insensitive', async () => {
    const { data } = (await get('/api/clubs?region=ohio&per_page=100')).json();
    assert.equal(data.length, 2, 'Columbus and Dayton');
  });

  test('tag filter uses OR within the facet', async () => {
    const { data } = (await get('/api/clubs?tags=zine,kids&per_page=100')).json();
    const slugs = data.map((c) => c.slug);
    assert.ok(slugs.includes('sample-brooklyn-zine-post'));
    assert.ok(slugs.includes('sample-chicago-kids-pen-pals'));
  });

  test('radius search finds nearby clubs and excludes far ones', async () => {
    // 120km around Columbus, Ohio reaches Dayton (~110km) but nothing further.
    const { data } = (await get(
      '/api/clubs?lat=39.9612&lng=-82.9988&radius_km=120&sort=distance&per_page=100')).json();
    const slugs = data.map((c) => c.slug);
    assert.ok(slugs.includes('sample-columbus-postcard-swap'));
    assert.ok(slugs.includes('sample-dayton-letter-league'));
    assert.ok(!slugs.includes('sample-brooklyn-zine-post'), 'Brooklyn is ~750km away');

    assert.equal(data[0].distance_km, 0, 'the club at the search point is 0km away');
    const distances = data.map((c) => c.distance_km);
    assert.deepEqual(distances, [...distances].sort((a, b) => a - b),
      'sort=distance must return ascending distances');
  });

  test('radius search is a circle, not a bounding box', async () => {
    // A point ~119km from Columbus on the diagonal: inside the box that a naive
    // implementation would use, outside the true circle.
    const { data } = (await get(
      '/api/clubs?lat=40.9&lng=-84.1&radius_km=100&per_page=100')).json();
    for (const club of data) {
      assert.ok(club.distance_km <= 100,
        `${club.slug} at ${club.distance_km}km leaked past the radius`);
    }
  });

  test('half-filled geo params are ignored rather than erroring', async () => {
    const res = await get('/api/clubs?lat=39.9612&per_page=100');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().meta.total, 12);
  });

  test('rejects out-of-range coordinates', async () => {
    const res = await get('/api/clubs?lat=999&lng=0&radius_km=10');
    assert.equal(res.statusCode, 400);
  });

  test('pagination reports a stable total', async () => {
    const { meta, data } = (await get('/api/clubs?per_page=5&page=2')).json();
    assert.equal(meta.total, 12);
    assert.equal(meta.pages, 3);
    assert.equal(data.length, 5);
  });

  test('detail endpoint returns one club with its tags', async () => {
    const res = await get('/api/clubs/sample-columbus-postcard-swap');
    assert.equal(res.statusCode, 200);
    const club = res.json().data;
    assert.equal(club.name, 'Columbus Postcard Swap');
    assert.deepEqual(club.tags.map((t) => t.slug).sort(), ['beginner', 'postcard']);
  });

  test('detail endpoint hides pending clubs', async () => {
    assert.equal((await get('/api/clubs/sample-pending-example')).statusCode, 404);
  });

  test('filters endpoint returns facet counts', async () => {
    const body = (await get('/api/filters')).json();
    assert.ok(body.countries.length >= 6);
    assert.ok(body.tags.some((t) => t.slug === 'postcard' && t.count > 0));
    assert.equal(body.price.min_cents, 0);
    // Kyoto is the dearest at about $15.90/mo. Were this reported from the
    // native column it would read 250000 (the raw JPY minor units).
    assert.ok(body.price.max_cents > 0 && body.price.max_cents < 10000,
      `facet max should be a sane USD figure, got ${body.price.max_cents}`);
  });
});

describe('accounts', () => {
  test('register, whoami, logout', async () => {
    const res = await post('/api/auth/register', {
      email: 'Alice@Example.com', password: 'correct horse battery',
      display_name: 'Alice',
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().data.email, 'alice@example.com', 'email is normalised');
    assert.equal(res.json().data.role, 'member', 'new users are never admins');

    const cookie = cookieFrom(res);
    const me = await get('/api/auth/me', { cookie });
    assert.equal(me.json().data.display_name, 'Alice');

    const out = await post('/api/auth/logout', {}, { cookie });
    assert.equal(out.statusCode, 200);
    assert.equal((await get('/api/auth/me', { cookie })).statusCode, 401,
      'the session must be dead after logout');
  });

  test('session cookie is httpOnly and sameSite', async () => {
    const res = await post('/api/auth/register',
      { email: 'cookie@example.com', password: 'a-long-enough-password' });
    const raw = (Array.isArray(res.headers['set-cookie'])
      ? res.headers['set-cookie'] : [res.headers['set-cookie']])
      .find((c) => c.startsWith('smt_session='));
    assert.match(raw, /HttpOnly/i, 'JS on the page must not be able to read the session');
    assert.match(raw, /SameSite=Lax/i);
  });

  test('the password hash never leaves the server', async () => {
    const res = await post('/api/auth/register',
      { email: 'leak@example.com', password: 'a-long-enough-password' });
    assert.ok(!JSON.stringify(res.json()).includes('scrypt'));
  });

  test('rejects a short password', async () => {
    const res = await post('/api/auth/register',
      { email: 'short@example.com', password: 'abc' });
    assert.equal(res.statusCode, 400);
  });

  test('rejects a duplicate email', async () => {
    const body = { email: 'dupe@example.com', password: 'a-long-enough-password' };
    assert.equal((await post('/api/auth/register', body)).statusCode, 201);
    assert.equal((await post('/api/auth/register', body)).statusCode, 409);
  });

  test('login works and a wrong password does not', async () => {
    await post('/api/auth/register',
      { email: 'login@example.com', password: 'a-long-enough-password' });

    const ok = await post('/api/auth/login',
      { email: 'login@example.com', password: 'a-long-enough-password' });
    assert.equal(ok.statusCode, 200);

    const bad = await post('/api/auth/login',
      { email: 'login@example.com', password: 'wrong-password-here' });
    assert.equal(bad.statusCode, 401);

    const missing = await post('/api/auth/login',
      { email: 'nobody@example.com', password: 'wrong-password-here' });
    assert.equal(missing.statusCode, 401);
    assert.equal(bad.json().message, missing.json().message,
      'identical message for bad password and unknown user, so addresses cannot be probed');
  });
});

describe('submissions', () => {
  const club = {
    name: 'Test Submitted Club', description: 'Created by the test suite.',
    url: 'https://example.com/test', price_cents: 700, price_period: 'monthly',
    country_code: 'us', region: 'Ohio', city: 'Akron',
    lat: 41.0814, lng: -81.5190, tags: ['postcard', 'Brand New Tag'],
  };

  test('requires sign in', async () => {
    assert.equal((await post('/api/clubs', club)).statusCode, 401);
  });

  test('signed-in submission lands as pending, not public', async () => {
    const reg = await post('/api/auth/register',
      { email: 'submitter@example.com', password: 'a-long-enough-password' });
    const cookie = cookieFrom(reg);

    const res = await post('/api/clubs', club, { cookie });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().data.location.country_code, 'US', 'country is upper-cased');

    const found = (await get('/api/clubs?q=Test Submitted Club')).json();
    assert.equal(found.meta.total, 0, 'a fresh submission must not be publicly searchable');

    const mine = (await get('/api/me/submissions', { cookie })).json();
    assert.equal(mine.data.length, 1);
    assert.equal(mine.data[0].status, 'pending');
  });

  test('two clubs with the same name get distinct slugs', async () => {
    const reg = await post('/api/auth/register',
      { email: 'slugs@example.com', password: 'a-long-enough-password' });
    const cookie = cookieFrom(reg);

    const first  = await post('/api/clubs', { ...club, name: 'Duplicate Name Club' }, { cookie });
    const second = await post('/api/clubs', { ...club, name: 'Duplicate Name Club' }, { cookie });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(first.json().data.slug, 'duplicate-name-club');
    assert.notEqual(second.json().data.slug, first.json().data.slug,
      'a slug collision must not overwrite the first club');
  });

  test('rejects a javascript: url', async () => {
    const reg = await post('/api/auth/register',
      { email: 'xss@example.com', password: 'a-long-enough-password' });
    const res = await post('/api/clubs',
      { ...club, name: 'Bad Link Club', url: 'javascript:alert(1)' },
      { cookie: cookieFrom(reg) });
    assert.equal(res.statusCode, 400);
  });

  test('rejects an unknown price period', async () => {
    const reg = await post('/api/auth/register',
      { email: 'period@example.com', password: 'a-long-enough-password' });
    const res = await post('/api/clubs',
      { ...club, name: 'Bad Period Club', price_period: 'fortnightly' },
      { cookie: cookieFrom(reg) });
    assert.equal(res.statusCode, 400);
  });
});

describe('moderation', () => {
  const adminLogin = () =>
    post('/api/auth/login', { email: 'admin@test.local', password: 'admin-password-123' });

  test('members cannot reach the admin queue', async () => {
    const reg = await post('/api/auth/register',
      { email: 'nosy@example.com', password: 'a-long-enough-password' });
    const res = await get('/api/admin/clubs', { cookie: cookieFrom(reg) });
    assert.equal(res.statusCode, 403);
  });

  test('anonymous callers cannot reach the admin queue', async () => {
    assert.equal((await get('/api/admin/clubs')).statusCode, 401);
  });

  test('an admin can approve a pending club into public search', async () => {
    const cookie = cookieFrom(await adminLogin());

    const queue = (await get('/api/admin/clubs?status=pending', { cookie })).json();
    const target = queue.data.find((c) => c.slug === 'sample-pending-example');
    assert.ok(target, 'the seeded pending club should be in the queue');

    const res = await app.inject({
      method: 'PATCH', url: `/api/admin/clubs/${target.id}`,
      payload: { status: 'approved' }, headers: { cookie },
    });
    assert.equal(res.statusCode, 200);

    const now = (await get('/api/clubs/sample-pending-example')).json();
    assert.equal(now.data.slug, 'sample-pending-example',
      'approving must make the club publicly visible');
  });

  test('an admin can reject with a reason', async () => {
    const cookie = cookieFrom(await adminLogin());
    const queue = (await get('/api/admin/clubs?status=pending', { cookie })).json();
    const target = queue.data.find((c) => c.slug === 'sample-pending-example-2');
    assert.ok(target, 'the second seeded pending club should still be queued');

    const res = await app.inject({
      method: 'PATCH', url: `/api/admin/clubs/${target.id}`,
      payload: { status: 'rejected', reject_reason: 'Not a real club.' },
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.status, 'rejected');
  });

  test('the queue flags a foreign-currency club with no exchange rate', async () => {
    const cookie = cookieFrom(await adminLogin());
    const reg = await post('/api/auth/register',
      { email: 'eurosubmitter@example.com', password: 'a-long-enough-password' });

    await post('/api/clubs', {
      name: 'Euro Rate Missing Club', price_cents: 1400,
      price_currency: 'EUR', price_period: 'monthly',
    }, { cookie: cookieFrom(reg) });

    const queue = (await get('/api/admin/clubs?status=pending', { cookie })).json();
    const target = queue.data.find((c) => c.slug === 'euro-rate-missing-club');
    assert.equal(target.needs_fx_rate, true,
      'a EUR club with no rate must be flagged before it is approved');

    // Setting the rate clears the flag and corrects the USD price.
    const res = await app.inject({
      method: 'PATCH', url: `/api/admin/clubs/${target.id}`,
      payload: { fx_to_usd: 1.08 }, headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.price.usd_monthly_cents, 1512,
      'EUR 14 at 1.08 is USD 15.12');
  });

  test('a non-numeric club id is rejected', async () => {
    const cookie = cookieFrom(await adminLogin());
    const res = await app.inject({
      method: 'PATCH', url: '/api/admin/clubs/not-a-number',
      payload: { status: 'approved' }, headers: { cookie },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('rate limiting', () => {
  test('repeated failed logins are throttled', async () => {
    // A separate app instance with the limiter switched on, so we are testing
    // the real production configuration rather than trusting it by inspection.
    const limited = await build({ rateLimit: true });
    try {
      const attempt = () => limited.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: 'admin@test.local', password: 'wrong-password-here' },
      });

      let sawTooMany = false;
      for (let i = 0; i < 15; i++) {
        if ((await attempt()).statusCode === 429) { sawTooMany = true; break; }
      }
      assert.ok(sawTooMany, 'brute-forcing a password must eventually return 429');
    } finally {
      await limited.close();
    }
  });
});
