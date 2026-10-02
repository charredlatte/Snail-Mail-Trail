# Scripts

Command-line tools. Both read `DATABASE_URL` from the environment.

## `init-db.js` — set up the database

```bash
npm run init-db                              # create tables only
npm run init-db -- --seed                    # tables + sample clubs
npm run init-db -- --admin you@domain.com    # tables + an admin account
```

Safe to re-run: the schema uses `IF NOT EXISTS` and the seed uses
`ON CONFLICT DO NOTHING`.

The admin password is prompted for, never passed as an argument — an argument
would land in your shell history and be visible in the process list. Running
`--admin` against an existing email promotes that account and resets its
password, which is also how you recover from a lost admin login.

## `import-clubs.js` — bulk load from a spreadsheet

```bash
npm run import -- clubs.csv                  # import as pending
npm run import -- clubs.csv --approved       # publish immediately
npm run import -- clubs.csv --geocode        # look up missing coordinates
npm run import -- clubs.csv --no-fx          # skip the exchange rate lookup
```

Export your spreadsheet as CSV with this header row. Only `name` is required:

```csv
name,description,url,price,currency,period,country,region,city,lat,lng,ships_worldwide,tags,fx_to_usd
Columbus Postcard Swap,Monthly swap,https://example.com,5.00,USD,monthly,US,Ohio,Columbus,,,false,postcard;beginner,
```

| Column | Notes |
|--------|-------|
| `price` | Whole currency units, as you would type in a spreadsheet: `12.50` |
| `period` | `free`, `monthly`, `quarterly`, `yearly`, `one_time`, `per_swap` |
| `country` | Two-letter code: `US`, `GB`, `JP` |
| `region` | State, province or county |
| `lat`/`lng` | Leave blank and pass `--geocode` to look them up |
| `ships_worldwide` | `true` / `yes` / `1` |
| `tags` | Semicolon-separated: `postcard;beginner` |
| `fx_to_usd` | Leave blank. Only set it to pin a specific rate |

**Re-importing updates rather than duplicates.** Rows are matched on the slug
derived from the name, so fixing a typo in your spreadsheet and re-running
updates the existing club.

### About exchange rates

Price filtering compares everything in US dollars, so any listing not priced in
USD needs an exchange rate or it will be filtered as though its number were
dollars — a GBP 14 club treated as a $14 one.

The importer handles this for you. If any row is in a foreign currency it makes
one request to [Frankfurter](https://frankfurter.dev) (European Central Bank
rates, free, no API key) and applies the right rate to each row. Leave the
`fx_to_usd` column blank unless you want to pin a specific rate.

If the lookup fails, the import still succeeds and prints exactly which listings
ended up without a rate, so nothing is silently mispriced. Those also show up in
the admin queue with `needs_fx_rate: true`, and you can set the rate there.

Rates are stored per listing rather than looked up on every search, so a club's
price does not move because a currency did. Re-run the importer over the same
spreadsheet to refresh them.

### About `--geocode`

Uses [Nominatim](https://nominatim.openstreetmap.org), OpenStreetMap's free
geocoder. Their usage policy requires an identifying `User-Agent` and no more
than one request per second — both are honoured, which means roughly one row per
second. Set `GEOCODER_CONTACT` in `.env` to your email address.

Fine for a few hundred rows. For tens of thousands, use a paid geocoder or
collect coordinates as you collect the listings.

Clubs without coordinates still work everywhere except radius search — they
simply will not appear in "within 50km of me" results, and will not have a map
pin.
