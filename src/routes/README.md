# Routes

One file per area of the API. Each exports a Fastify plugin registered in
`server.js`.

| File | Endpoints | Who can call them |
|------|-----------|-------------------|
| `clubs.js` | search, filters, detail, submit | public, except submit |
| `auth.js` | register, login, logout, me | public |
| `admin.js` | moderation queue, approve/reject/edit/delete | admins only |

Full request and response shapes are in [`docs/API.md`](../../docs/API.md).

## Conventions

**Validation is declarative.** Every route carries a JSON schema. Fastify
rejects anything that does not match before the handler runs, so handlers can
assume their input is well-formed. Adding a new field means adding it to the
schema — otherwise it is silently dropped, which is the safe default.

**Responses are wrapped.** Single items return `{ data }`, lists return
`{ data, meta }` where `meta` carries pagination. Errors return
`{ error, message }` — `error` is a stable machine-readable code, `message` is
text you can show a person.

**Guards are `preHandler` hooks**, not checks inside the handler. `requireAuth`
and `requireAdmin` come from `../auth.js`. A route with no guard is public, so
the absence of a guard is a visible decision when reading the file.

## Things that are easy to get wrong here

- `clubs.js` **forces every submission to `status = 'pending'`**. The status
  field is not settable through the submit endpoint, only through the admin one.
  Keep it that way, or the moderation queue becomes decorative.
- `admin.js` builds its `UPDATE` clause dynamically, but **column names come
  from a fixed `ALLOWED` list**, never from the request body. Values are always
  bound parameters. Do not "simplify" this into interpolating the body's keys.
- The submit endpoint **rejects any URL that is not http(s)**, which is what
  stops a `javascript:` link being stored and later rendered by the front end.
