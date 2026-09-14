# Snail Mail Trail

Backend for a snail mail club directory. People search for pen pal circles,
postcard swaps and stationery subscriptions by **price**, **location** and
**category**, and see the results on a map.

This repository is the API and the database. The front end is a separate thing
that talks to it over JSON.

## What it does

- **Search** across clubs with full-text matching that tolerates typos
- **Filter** by price range, country, state/region, category tags and price model
- **Find nearby** clubs within a radius of any point, sorted by real distance
- **Accounts** so people can sign in and submit clubs they know about
- **Moderation** so nothing reaches the public directory until you approve it

## Quick start

```bash
npm install
cp .env.example .env          # then edit DATABASE_URL
npm run init-db -- --seed     # create tables and load sample clubs
npm start                     # http://localhost:3000
```

Check it is alive:

```bash
curl localhost:3000/api/health
curl "localhost:3000/api/clubs?max_price=1000&sort=price_asc"
```

Give yourself an admin account so you can approve submissions:

```bash
npm run init-db -- --admin you@yourdomain.com
```

## Repository map

Every directory has its own README explaining what lives there and why.

| Path | What it is |
|------|-----------|
| [`src/`](src/README.md) | The API server: database access, auth, search |
| [`src/routes/`](src/routes/README.md) | HTTP endpoints, one file per area |
| [`db/`](db/README.md) | Schema and sample data |
| [`scripts/`](scripts/README.md) | Setup and bulk import tools |
| [`tests/`](tests/README.md) | End-to-end test suite |
| [`docs/`](docs/README.md) | API reference, deployment, security notes |

Start with [`docs/API.md`](docs/API.md) if you are building the front end, and
[`docs/DEPLOY.md`](docs/DEPLOY.md) when you are ready to put it on a server.

## Why this stack

**Node 22 + Fastify + PostgreSQL.**

Postgres is the part that matters. A directory like this is really a small
vertical search engine, and the hard query is "text match, plus these filters,
plus within this radius, ranked sensibly" — all at once. Postgres does that in
one query with `tsvector` full-text, `pg_trgm` fuzzy matching and plain
trigonometry for distance. MySQL on cheap shared hosting cannot, and bolting on
a separate search service later costs far more than starting here.

Fastify validates every incoming request against a JSON schema before your code
sees it, which is worth more on a public API than compile-time types. There is
no build step and no TypeScript — `npm start` runs the source directly.

Five dependencies total. Password hashing uses Node's built-in `scrypt` rather
than adding a crypto library.

## Known limitations

Worth knowing before you launch, in rough order of when they will bite:

- **Mixed currencies are compared as bare numbers.** A club priced at 6 CAD
  sorts as if it were 6 USD. Fine while your listings are mostly one currency;
  if that stops being true, store a converted `usd_cents` column at import time.
- **No email sending.** No password reset, no email verification, no "your club
  was approved" notification. Adding these needs an SMTP provider.
- **Radius search scans the matching rows.** Instant up to roughly 50,000 clubs.
  Past that, switch the bounding box to a PostGIS `GEOGRAPHY` column with a GiST
  index — the query shape stays the same.
- **Moderation is manual.** Every submission waits for a human. That is the
  right default for a small directory and the wrong one at scale.

## Tests

```bash
createdb snailmail_test
TEST_DATABASE_URL=postgres://user:pass@localhost/snailmail_test npm test
```

32 tests covering search, geo, filtering, accounts, submissions and moderation.
They run against a real Postgres database rather than mocks, because most of the
logic worth testing here *is* the SQL.
