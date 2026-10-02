-- Snail Mail Trail :: database schema (PostgreSQL 14+)
--
-- Design notes live in db/README.md. Short version: three domains of data --
-- people (users, sessions), clubs (clubs, tags, club_tags), and the moderation
-- status that connects them.
--
-- Safe to re-run: every object is created IF NOT EXISTS.

-- pg_trgm powers fuzzy name matching ("stationary" should find "stationery").
-- Ships with Postgres, no install needed, just enable it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- Converts a price in any billing period to its monthly equivalent.
--
-- This exists as a function because Postgres forbids a generated column from
-- referencing another generated column -- both monthly_cents and
-- usd_monthly_cents need this maths, and duplicating the CASE into each one is
-- how they would eventually drift apart.
--
-- Must stay IMMUTABLE or the generated columns below cannot use it. Note that
-- changing this function does NOT recompute already-stored rows; see
-- db/README.md for the backfill if you ever do change it.
CREATE OR REPLACE FUNCTION monthly_equivalent_cents(cents INTEGER, period TEXT)
  RETURNS INTEGER
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT CASE period
    WHEN 'free'      THEN 0
    WHEN 'monthly'   THEN cents
    WHEN 'quarterly' THEN cents / 3
    WHEN 'yearly'    THEN cents / 12
    ELSE cents                      -- one_time, per_swap: compared as-is
  END
$$;


-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          TEXT        NOT NULL,
  password_hash  TEXT        NOT NULL,
  display_name   TEXT        NOT NULL,
  role           TEXT        NOT NULL DEFAULT 'member'
                             CHECK (role IN ('member', 'admin')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Emails are stored already-lowercased by the application layer, so a plain
-- unique index is enough and we avoid needing the citext extension.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);


-- Opaque session tokens. We store only the SHA-256 hash of the token, so a
-- leaked database dump cannot be replayed as a valid login.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT        PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);


-- ---------------------------------------------------------------------------
-- Clubs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS clubs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug            TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  description     TEXT        NOT NULL DEFAULT '',
  url             TEXT,

  -- Price is stored in the club's own currency, in minor units (cents), so we
  -- never do float maths on money.
  price_cents     INTEGER     NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  price_currency  TEXT        NOT NULL DEFAULT 'USD' CHECK (char_length(price_currency) = 3),
  price_period    TEXT        NOT NULL DEFAULT 'monthly'
                              CHECK (price_period IN
                                ('free','monthly','quarterly','yearly','one_time','per_swap')),

  -- How many US dollars ONE unit of this club's currency is worth, captured when
  -- the listing was entered. So a GBP club stores ~1.27 (one pound buys 1.27
  -- dollars) and a JPY club stores ~0.0067. Getting this direction backwards is
  -- the easy mistake: it is USD-per-unit, not units-per-USD.
  --
  -- NULL means "not converted yet" and is treated as 1.0, which is correct for
  -- USD clubs and wrong for every other currency -- so the admin queue flags
  -- which non-USD listings are still missing a rate.
  --
  -- Stored per club rather than looked up live on purpose: a search result must
  -- not change price because a currency moved, and a directory does not need
  -- real-time FX. scripts/import-clubs.js fills this in at import time.
  fx_to_usd       NUMERIC(14,6) CHECK (fx_to_usd IS NULL OR fx_to_usd > 0),

  -- Location. country_code is ISO 3166-1 alpha-2 ('US', 'GB'). region is the
  -- state / province / county, needed for the "clubs in Ohio" case.
  country_code    TEXT        CHECK (country_code IS NULL OR char_length(country_code) = 2),
  region          TEXT,
  city            TEXT,
  lat             DOUBLE PRECISION CHECK (lat  IS NULL OR (lat  BETWEEN  -90 AND  90)),
  lng             DOUBLE PRECISION CHECK (lng  IS NULL OR (lng  BETWEEN -180 AND 180)),

  -- A club that mails anywhere should surface even when someone filters by
  -- country, so the search layer treats this as an escape hatch.
  ships_worldwide BOOLEAN     NOT NULL DEFAULT false,

  -- Moderation. Public search only ever returns 'approved'.
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved','rejected')),
  reject_reason   TEXT,
  submitted_by    BIGINT      REFERENCES users (id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Monthly equivalent in the club's OWN currency. Display only: it is what you
  -- show a visitor as "works out to GBP 14/month".
  monthly_cents   INTEGER GENERATED ALWAYS AS (
                    monthly_equivalent_cents(price_cents, price_period)
                  ) STORED,

  -- Monthly equivalent converted to US cents. This is the only column price
  -- filtering and sorting may use: comparing a bare 1400 GBP-cents against
  -- 1400 USD-cents treats a GBP 14 club as if it cost USD 14, which is the
  -- cross-currency bug this column exists to prevent.
  usd_monthly_cents INTEGER GENERATED ALWAYS AS (
                    round(monthly_equivalent_cents(price_cents, price_period)
                          * COALESCE(fx_to_usd, 1))::INTEGER
                  ) STORED,

  -- Full-text search document. Weighted: a name match outranks a description
  -- match, which outranks a city match.
  search_doc      tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('english', coalesce(name, '')),        'A') ||
                    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
                    setweight(to_tsvector('english',
                      coalesce(city, '') || ' ' || coalesce(region, '')), 'C')
                  ) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS clubs_slug_key ON clubs (slug);

-- Partial indexes: public search always filters status='approved', so indexing
-- only those rows keeps the indexes small and the planner happy.
CREATE INDEX IF NOT EXISTS clubs_search_doc_idx
  ON clubs USING GIN (search_doc) WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS clubs_name_trgm_idx
  ON clubs USING GIN (name gin_trgm_ops) WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS clubs_usd_monthly_cents_idx
  ON clubs (usd_monthly_cents) WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS clubs_country_region_idx
  ON clubs (country_code, region) WHERE status = 'approved';

-- Supports the bounding-box prefilter used by radius search.
CREATE INDEX IF NOT EXISTS clubs_lat_lng_idx
  ON clubs (lat, lng) WHERE status = 'approved' AND lat IS NOT NULL;

-- The moderation queue: "show me everything still pending".
CREATE INDEX IF NOT EXISTS clubs_status_created_idx ON clubs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS clubs_submitted_by_idx ON clubs (submitted_by);


-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tags (
  id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug  TEXT NOT NULL,
  name  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tags_slug_key ON tags (slug);

CREATE TABLE IF NOT EXISTS club_tags (
  club_id BIGINT NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  tag_id  BIGINT NOT NULL REFERENCES tags  (id) ON DELETE CASCADE,
  PRIMARY KEY (club_id, tag_id)
);

-- Reverse lookup: "every club tagged postcard".
CREATE INDEX IF NOT EXISTS club_tags_tag_id_idx ON club_tags (tag_id, club_id);


-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clubs_touch_updated_at ON clubs;
CREATE TRIGGER clubs_touch_updated_at
  BEFORE UPDATE ON clubs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
