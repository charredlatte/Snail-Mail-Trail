# API reference

Base URL: `https://yourdomain.com` (or `http://localhost:3000` in development).

All responses are JSON. Single items come back as `{ data }`, lists as
`{ data, meta }`. Errors are `{ error, message }` where `error` is a stable code
to branch on and `message` is text safe to show a person.

Authentication is a session cookie set on login. From the browser, **every
request must send `credentials: 'include'`** or the cookie will not travel.

---

## `GET /api/clubs` — search

The main endpoint. Every parameter is optional; with none, it returns the first
page of everything approved.

| Parameter | Type | Meaning |
|-----------|------|---------|
| `q` | string | Free text. Matches name, description and city. Tolerates typos. |
| `country` | 2 letters | `US`, `GB`, `JP`. Also returns worldwide shippers. |
| `region` | string | State / province. Case-insensitive. |
| `tags` | string | Comma-separated slugs: `postcard,zine`. Matches **any**. |
| `min_price` | integer | Minimum **US cents per month**. `0` = free. |
| `max_price` | integer | Maximum **US cents per month**. `1000` = $10/month. |
| `period` | string | `free`, `monthly`, `quarterly`, `yearly`, `one_time`, `per_swap` |
| `lat`, `lng` | number | Centre point for a radius search. |
| `radius_km` | number | Radius in kilometres. Needs `lat` and `lng` too. |
| `sort` | string | `relevance` (default), `price_asc`, `price_desc`, `distance`, `newest`, `name` |
| `page` | integer | 1-based. Default `1`. |
| `per_page` | integer | Default `24`, max `100`. |

**Prices are in US cents per month, normalised twice.** First for billing
period: a club charging $90/year is compared as $7.50/month. Then for currency:
a club charging GBP 14/month is compared as about $17.78/month, not as 1400.

That is the whole point of the filter — someone says "under $10 a month" and
gets an honest answer across clubs that bill on different schedules in
different currencies.

Each result carries both figures, and they are not interchangeable:

| Field | Use it for |
|-------|-----------|
| `price.cents` + `price.currency` + `price.period` | showing the real price: "GBP 14 / month" |
| `price.monthly_cents` | monthly equivalent **in the club's own currency** |
| `price.usd_monthly_cents` | monthly equivalent **in US cents** — matches the filter |

So show `cents`/`currency`/`period` on a club card, and `usd_monthly_cents`
whenever the user is comparing or sorting by price.

`price.fx_to_usd` is the rate used (US dollars per one unit of the club's
currency). It is `null` when no rate has been recorded, which means
`usd_monthly_cents` fell back to treating the amount as dollars — accurate for
USD clubs, approximate for anything else.

**`lat`, `lng` and `radius_km` must all three be present** for a radius search.
Supplying only some of them is treated as a half-filled form and the geo filter
is ignored, rather than returning an error — so your UI can leave
`sort=distance` selected while the user is still picking a location.

### Example

```
GET /api/clubs?q=postcard&country=US&region=Ohio&max_price=2000&tags=beginner&sort=price_asc
GET /api/clubs?lat=39.9612&lng=-82.9988&radius_km=100&sort=distance
```

### Response

```json
{
  "data": [
    {
      "id": 1,
      "slug": "columbus-postcard-swap",
      "name": "Columbus Postcard Swap",
      "description": "Monthly postcard exchange for central Ohio.",
      "url": "https://example.com/columbus-postcard-swap",
      "price": {
        "cents": 500,
        "currency": "USD",
        "period": "monthly",
        "monthly_cents": 500,
        "usd_monthly_cents": 500,
        "fx_to_usd": 1
      },
      "location": {
        "country_code": "US",
        "region": "Ohio",
        "city": "Columbus",
        "lat": 39.9612,
        "lng": -82.9988,
        "ships_worldwide": false
      },
      "tags": [{ "slug": "postcard", "name": "Postcard" }],
      "distance_km": 0,
      "created_at": "2026-09-14T11:00:00.000Z"
    }
  ],
  "meta": { "total": 12, "page": 1, "per_page": 24, "pages": 1 }
}
```

`distance_km` is `null` unless you searched by radius. `lat` and `lng` are
`null` for clubs with no known location — skip those when placing map pins.

---

## `GET /api/filters` — build your filter UI

Returns the real values present in the database with counts, so your dropdowns
and checkboxes never drift out of sync with the data.

```json
{
  "countries": [{ "country_code": "US", "count": 7 }],
  "regions":   [{ "country_code": "US", "region": "Ohio", "count": 2 }],
  "tags":      [{ "slug": "postcard", "name": "Postcard", "count": 2 }],
  "price":     { "min_cents": 0, "max_cents": 2083 },
  "periods":   ["free", "monthly", "quarterly", "yearly", "one_time", "per_swap"]
}
```

`price` gives you the real bounds for a price slider, in **US cents per month** —
the same unit `min_price` and `max_price` take, so you can wire the slider
straight to the filter.

---

## `GET /api/clubs/:slug` — one club

Returns `{ data }` in the same shape as a search result, or `404` with
`error: "not_found"`. Only ever returns approved clubs.

---

## Accounts

### `POST /api/auth/register`

```json
{ "email": "you@example.com", "password": "at least ten chars", "display_name": "Optional" }
```

`201` with `{ data: user }` and sets the session cookie. `409` with
`error: "email_taken"` if the address is registered. Passwords must be at least
10 characters; there are no composition rules.

### `POST /api/auth/login`

```json
{ "email": "you@example.com", "password": "..." }
```

`200` with `{ data: user }` and sets the session cookie. `401` with
`error: "invalid_credentials"` otherwise — deliberately the same response for a
wrong password and an unknown address, so the endpoint cannot be used to
discover which emails are registered.

### `POST /api/auth/logout`

`200 { ok: true }` and clears the cookie. The session is deleted server-side,
so the token is dead immediately.

### `GET /api/auth/me`

`200` with `{ data: user }`, or `401` if not signed in. Use this on page load to
decide whether to show a signed-in state.

A `user` is `{ id, email, display_name, role }`. `role` is `member` or `admin`.

---

## Submitting a club

### `POST /api/clubs` — requires sign in

```json
{
  "name": "Columbus Postcard Swap",
  "description": "Monthly postcard exchange.",
  "url": "https://example.com",
  "price_cents": 500,
  "price_currency": "USD",
  "price_period": "monthly",
  "country_code": "US",
  "region": "Ohio",
  "city": "Columbus",
  "lat": 39.9612,
  "lng": -82.9988,
  "ships_worldwide": false,
  "tags": ["postcard", "beginner"]
}
```

Only `name` is required. Returns `201` with the created club and a message you
can show the user.

**Submissions do not set an exchange rate.** A club submitted in a currency
other than USD is flagged in the admin queue, and an admin sets the rate when
approving it. Your form only needs to collect `price_cents`, `price_currency`
and `price_period`.

**Every submission is created as `pending`** and is invisible in search until an
admin approves it. Your form should say so. Tags that do not exist yet are
created automatically.

`url` must be `http` or `https` — anything else is rejected with
`error: "invalid_url"`. Rate limited to 10 submissions per hour per IP.

### `GET /api/me/submissions` — requires sign in

The signed-in user's own submissions in every status, each with `status` and
`reject_reason`. This is what powers a "my submissions" page.

---

## Moderation — admins only

Non-admins get `403`, signed-out callers get `401`.

### `GET /api/admin/clubs?status=pending`

The review queue. `status` is `pending` (default), `approved` or `rejected`.
Paginated like search. Each entry adds two fields:

- `submitter_email` — who submitted it
- `needs_fx_rate` — `true` when the listing is priced in a foreign currency with
  no exchange rate recorded. Approving it in that state prices it as though the
  amount were dollars, so set `fx_to_usd` first.

### `PATCH /api/admin/clubs/:id`

Send any subset of fields. Approving and editing share one endpoint because
admins routinely need to fix a typo or add coordinates before publishing.

```json
{ "status": "approved" }
{ "status": "rejected", "reject_reason": "Not a real club." }
{ "city": "Columbus", "lat": 39.9612, "lng": -82.9988, "status": "approved" }
```

### `DELETE /api/admin/clubs/:id`

Permanent. Use `status: "rejected"` instead if you want to keep a record.

---

## Errors

| Status | `error` | Meaning |
|--------|---------|---------|
| 400 | `validation_failed` | A parameter failed its schema. `message` says which. |
| 400 | `invalid_url` | Submitted URL was not http(s). |
| 401 | `unauthorized` | Not signed in. |
| 401 | `invalid_credentials` | Wrong email or password. |
| 403 | `forbidden` | Signed in, but not an admin. |
| 404 | `not_found` | No such club. |
| 409 | `email_taken` | That address is already registered. |
| 429 | — | Rate limited. Back off and retry. |
| 500 | `server_error` | Something broke. Details are in the server log, not here. |

---

## Front-end notes

**Cookies need `credentials`.** Without it the browser silently drops the
session cookie and every authenticated request 401s:

```js
const res = await fetch(`${API}/api/auth/me`, { credentials: 'include' });
```

**Your origin must be in `CORS_ORIGIN`** on the server. Wildcards are not
allowed alongside credentials — that is a browser rule, not a configurable one.

**Debounce the search box.** Every keystroke firing a request will hit the
300/minute rate limit. 300ms of debounce is plenty.

**For map pins, request `per_page=100`** and filter out clubs where
`location.lat` is `null`.

**Do not print `price.cents / 100` with decimals for every currency.** Yen and
won have no minor unit, so JPY 2500 is stored as `250000` and should render as
"JPY 2,500", not "JPY 2500.00". `Intl.NumberFormat` handles this for you:

```js
new Intl.NumberFormat(undefined, { style: 'currency', currency: price.currency })
  .format(price.cents / 100);
```
