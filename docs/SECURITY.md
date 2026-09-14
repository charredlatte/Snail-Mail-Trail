# Security

What this application protects against, how, and — just as importantly — what it
does not protect against yet.

## Passwords

Hashed with **scrypt**, built into Node. No crypto dependency to keep patched.

- A fresh 16-byte random salt per password, so identical passwords hash
  differently and precomputed tables are useless.
- Parameters `N=16384, r=8, p=1` — roughly 16MB of memory per hash, which is
  what makes parallel cracking expensive.
- Verification uses `timingSafeEqual`, so comparison time does not leak how much
  of the hash was correct.
- The stored format is `scrypt$N$r$p$salt$hash`. Because it records its own
  parameters, you can raise the cost later and old hashes keep verifying.

Minimum length is 10 characters with **no composition rules**. This follows
current NIST guidance: length beats forced variety, and "must contain a symbol"
mostly produces `Password1!`.

## Sessions

Opaque 256-bit random tokens, not JWTs. A JWT cannot be revoked before it
expires; here, logging out needs to kill the session immediately, and it does.

- The database stores only the **SHA-256 hash** of the token. A leaked database
  dump cannot be replayed as a login.
- The cookie is `httpOnly` (JavaScript on the page cannot read it, so an XSS bug
  cannot steal the session), `secure` in production (HTTPS only), and
  `sameSite=lax` (blocks cross-site POST requests, which covers CSRF for the
  state-changing endpoints here).
- Sessions expire after 30 days and expired rows are purged every 6 hours.

## SQL injection

Every value reaching the database is a **bound parameter**. There is no string
interpolation of user input into SQL anywhere in this codebase.

Two places build SQL dynamically, and both are worth understanding before you
edit them:

- `src/search.js` chooses its `ORDER BY` from a **fixed lookup table** of allowed
  sorts. An unrecognised value falls back to the default rather than reaching SQL.
- `src/routes/admin.js` builds its `UPDATE` clause from a **hardcoded `ALLOWED`
  column list**, never from the request body's keys. Values are still bound.

If you extend either, keep that shape. The moment a column or direction comes
from user input, this becomes injectable.

## Input validation

Every endpoint declares a JSON schema. Fastify rejects anything that does not
match **before the handler runs** — wrong types, out-of-range numbers, unknown
enum values, oversized strings. Fields not in the schema are dropped rather than
passed through.

Request bodies are capped at 256KB.

## Authorisation

- Public search returns `status = 'approved'` only. There is no parameter that
  can change this, so a pending submission cannot be surfaced by a crafted query.
- Submissions are **always** created as `pending`. The submit endpoint does not
  accept a `status` field at all.
- New accounts are always `role = 'member'`. Nothing in the public API can
  promote an account; that only happens through `scripts/init-db.js --admin`.
- Admin routes are guarded by a `preHandler`, not an inline check, so a route
  without a guard is visibly public when reading the file.

## Rate limiting

Per IP, enforced globally and tightened on the expensive endpoints:

| Endpoint | Limit |
|----------|-------|
| Everything | 300 / minute |
| `POST /api/auth/login` | 10 / 15 minutes |
| `POST /api/auth/register` | 5 / hour |
| `POST /api/clubs` | 10 / hour |

This depends on `X-Forwarded-For` being set correctly by your reverse proxy —
see [`DEPLOY.md`](DEPLOY.md). Get that wrong and every user shares one bucket.

## Information disclosure

- Login returns an **identical response** for a wrong password and an unknown
  email, so it cannot be used to discover which addresses are registered. The
  unknown-user path deliberately runs a hash anyway so the timing matches too.
- Password hashes are never included in any response.
- Internal errors are logged in full server-side and returned as a generic
  `500`. Stack traces and database errors never reach the client.

## Stored links

Submitted URLs must be `http` or `https`. This is what stops a `javascript:` or
`data:` URL being stored and later turned into a clickable link by the front
end. Rejected at submission with `error: "invalid_url"`.

## Output escaping is the front end's job

This API returns club names and descriptions as **raw text**, exactly as
submitted. That is correct — escaping belongs at the point of rendering, not
storage.

Your front end must not inject these into the page as HTML. In React, JSX
escapes by default and you are fine unless you reach for
`dangerouslySetInnerHTML`. In plain JavaScript, use `textContent`, never
`innerHTML`.

This is the most likely place for this project to acquire an XSS bug.

---

## Not covered yet

Honest gaps. None are blockers for launching a small directory, but know they
are there:

**No password reset.** A user who forgets their password cannot recover the
account without you resetting it manually. Needs an SMTP provider and a
short-lived single-use token table.

**No email verification.** Anyone can register with an address they do not own.
Combined with moderation on submissions, the blast radius is small.

**No CSRF tokens.** `sameSite=lax` covers the state-changing endpoints here,
since they are all `POST`/`PATCH`/`DELETE` and lax blocks cross-site requests
with those methods. If you ever add a state-changing `GET`, that protection does
not apply to it.

**No account lockout.** Rate limiting slows brute force but never locks an
account — deliberately, since lockout is itself a denial-of-service vector
against a known email address.

**No audit log.** Nothing records which admin approved or deleted what. Worth
adding if more than one person ever moderates.

**Session tokens are not rotated on login.** A user signing in repeatedly
accumulates valid sessions until they expire. Logging out kills only the current
one. Fine for this scale; add a "sign out everywhere" button before it is not.

## Reporting a problem

If you find a vulnerability, do not open a public issue. Email the address in
the repository owner's profile.
