# Source

The API server. No build step — Node runs these files directly.

| File | Responsibility |
|------|---------------|
| `server.js` | Entry point. Registers plugins and routes, handles shutdown. |
| `db.js` | Postgres connection pool and query helpers. |
| `auth.js` | Password hashing, sessions, route guards. |
| `search.js` | Builds the club search query. |
| `routes/` | HTTP endpoints — see [its README](routes/README.md). |

## How a request flows

1. `server.js` applies CORS, cookie parsing and rate limiting.
2. The `preHandler` hook calls `attachUser`, which sets `request.user` if a
   valid session cookie is present. It never rejects — that is a guard's job.
3. Fastify validates the query string or body against the route's JSON schema.
   Anything malformed is rejected with a 400 before the handler runs.
4. The handler runs, using `requireAuth` or `requireAdmin` as a `preHandler`
   when the route needs a signed-in user.
5. Errors go through one handler in `server.js`: validation errors and 4xx come
   back with their message, everything else is logged in full and answered with
   a generic 500. Internal details never reach the client.

## search.js

Separated from the route handler so the query logic can be read on its own.
`buildClubSearch()` takes validated options and returns `{ text, params }`.

Two things to know:

- **Every value is a bound parameter.** No user input is ever concatenated into
  SQL. The only dynamic SQL is the `ORDER BY` clause, and that is chosen from a
  fixed lookup table of allowed sorts.
- **Filter semantics:** values within the `tags` facet are OR'd (a club tagged
  either `postcard` or `zine` matches), while different facets are AND'd
  (tags AND country AND price). That is the convention faceted search UIs use.

Fuzzy matching uses `<%` (word similarity), not `%` (whole-string similarity).
The difference matters: searching "stationary" against "Portland Stationery
Society" scores far too low on whole-string similarity to match, because most of
the name is unrelated to the search term. `<%` compares against the best-matching
*word* inside the name instead.

## auth.js

Passwords use Node's built-in `scrypt` — a memory-hard KDF, no dependency
needed. Each password gets a random salt, and verification uses a timing-safe
comparison. The stored format (`scrypt$N$r$p$salt$hash`) records its own
parameters, so you can raise the cost later without invalidating old hashes.

Sessions are opaque 256-bit random tokens in an `httpOnly` cookie. Not JWTs —
a JWT cannot be revoked before it expires, and here logout genuinely needs to
kill the session immediately.

See [`docs/SECURITY.md`](../docs/SECURITY.md) for the full picture.
