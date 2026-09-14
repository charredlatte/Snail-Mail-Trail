# Tests

End-to-end tests against a real PostgreSQL database.

```bash
createdb snailmail_test
TEST_DATABASE_URL=postgres://user:pass@localhost/snailmail_test npm test
```

Defaults to `postgres://snailmail:devpassword@127.0.0.1:5432/snailmail_test` if
`TEST_DATABASE_URL` is unset. The database is rebuilt from `db/schema.sql` and
`db/seed.sql` on every run, so it is disposable — never point this at data you
care about, the first thing it does is `TRUNCATE`.

Uses Node's built-in test runner and Fastify's `inject()`, which drives the app
in-process without binding a port. No test framework, no mocking library.

## Why a real database

Most of the logic worth testing here *is* SQL — the generated `monthly_cents`
column, the haversine distance filter, the partial indexes, the `status`
visibility rule. Mocking the database would test the mock. These tests caught
three genuine bugs during development:

1. Whole-string similarity never matched a typo against a multi-word club name.
2. The auth rate limiter throttling legitimate signups from one IP.
3. A generated column that Postgres rejected as non-immutable.

## Coverage

| Area | What is asserted |
|------|-----------------|
| Search | full text, typo tolerance, tag OR-ing, region case-insensitivity |
| Price | `$90/year` qualifies under a `$10/month` filter; `$18/month` does not |
| Geo | distance sort order, worldwide shippers surfacing, out-of-range coords rejected |
| Visibility | pending clubs never appear in search or detail |
| Accounts | cookie flags, email normalisation, no hash leakage, no user enumeration |
| Submissions | auth required, always lands pending, `javascript:` URLs rejected |
| Moderation | members get 403, anonymous get 401, approve publishes |
| Rate limiting | brute-forced logins eventually return 429 |

Two assertions are worth keeping if you refactor:

- **The radius is a circle, not a box.** One test searches from a point where a
  naive bounding-box implementation would leak a club ~119km away out of a 100km
  radius. It asserts every result is genuinely within the radius.
- **Bad password and unknown user return an identical message.** If those ever
  diverge, the login endpoint becomes a tool for discovering which email
  addresses are registered.
