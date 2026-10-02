# Deploying

Target: any Ubuntu VPS with Docker, and your domain pointed at it. Two hosts are
documented below; **the setup from step 2 onwards is identical on both**, because
it is just Docker, nginx and certbot. Pick on price, not on lock-in.

## Picking a host

Prices checked October 2026 — verify before you buy, they move.

| | Hetzner CX22 | Hostinger KVM 1 |
|---|---|---|
| Monthly, no commitment | **~€4.59** | **$11.99** |
| Cheapest rate | same | $6.49, but only on a **2-year prepay** |
| vCPU / RAM / disk | 2 / 4GB / 40GB | 1 / 4GB / 50GB |
| Locations | EU + US (Ashburn, Hillsboro) | global |
| Why pick it | roughly double the CPU for a third of the month-to-month price | one vendor and one bill alongside your domain; 240+ Docker templates in hPanel |

**Hetzner is the better value** by a wide margin, and has no prepay commitment.
**Hostinger is the simpler life** if you would rather have the domain, DNS and
server on one invoice. Either runs this stack comfortably — the database will
sit well under 1GB.

Buy the domain wherever you like; you only need to point an A record at the
server's IP.

## What will not work

**Hostinger's $3 shared plan.** It runs PHP and MySQL, cannot run Node, and has
no PostgreSQL — and Postgres is what makes the search work (see the root
README). Shared hosting is not an option for this stack at any price.

**Managed Postgres, on cost.** Fly charges about $33.90/month, DigitalOcean $60,
Railway $92.50 — each several times the price of the whole VPS, for a database
holding well under 50MB. Neon's free tier would fit the data, but it scales to
zero, so the first search after an idle spell waits on a cold start. Bad trade
for a search site. Self-host Postgres in the compose file.

The code does not care either way: it only needs `DATABASE_URL`.

---

## 1. Point the domain

In Hostinger's DNS panel, create an **A record** for `@` and for `www` pointing
at your VPS's IP address. DNS takes a few minutes to an hour to propagate.

## 2. Prepare the server

Identical on Hetzner and Hostinger. SSH in as root, then:

```bash
# Create a non-root user to run the app
adduser snail && usermod -aG sudo snail

# Install Docker
curl -fsSL https://get.docker.com | sh
usermod -aG docker snail

# Firewall: SSH and web only. Postgres is never exposed.
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
```

Log back in as `snail` from here on.

## 3. Get the code and configure it

```bash
git clone <your-repo-url> ~/snail-mail-trail
cd ~/snail-mail-trail
cp .env.example .env
nano .env
```

Set these. **Generate the password, do not invent one:**

```bash
POSTGRES_PASSWORD=$(openssl rand -base64 24)
CORS_ORIGIN=https://yourdomain.com
COOKIE_SECURE=true
```

`CORS_ORIGIN` must be the exact origin your front end is served from, including
`https://`. If your front end lives at `www.yourdomain.com`, list both:
`https://yourdomain.com,https://www.yourdomain.com`.

## 4. Start it

```bash
docker compose up -d --build
docker compose exec api node scripts/init-db.js
docker compose exec -it api node scripts/init-db.js --admin you@yourdomain.com
```

The second command creates the tables. The third creates your admin account and
prompts for a password. Do **not** pass `--seed` in production unless you want
the fictional sample clubs.

Check it:

```bash
curl localhost:3000/api/health     # {"ok":true}
```

## 5. nginx and HTTPS

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo nano /etc/nginx/sites-available/snailmail
```

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    # Your built front end
    root /var/www/snailmail;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;    # SPA fallback
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`X-Forwarded-For` matters: the app trusts it to identify callers, and without it
every request looks like it comes from nginx and the rate limiter would throttle
all your users as one.

```bash
sudo ln -s /etc/nginx/sites-available/snailmail /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Certbot installs the certificate and sets up auto-renewal. Once HTTPS is live,
confirm `COOKIE_SECURE=true` is in your `.env` and run
`docker compose up -d` again.

Serving the front end from the same domain as the API is the easy path — CORS
stops being a concern and the session cookie is same-site by default.

---

## Backups

The database is the only thing you cannot rebuild. Set this up on day one,
before you have data worth losing:

```bash
mkdir -p ~/backups
crontab -e
```

```cron
0 3 * * * cd ~/snail-mail-trail && docker compose exec -T db pg_dump -U snailmail snailmail | gzip > ~/backups/snailmail-$(date +\%F).sql.gz
0 4 * * * find ~/backups -name '*.sql.gz' -mtime +30 -delete
```

Nightly dump at 3am, keeping 30 days. **Copy them off the server too** — a
backup that lives only on the machine it is backing up is not a backup. `rclone`
to any cloud storage covers this.

Restore with:

```bash
gunzip -c ~/backups/snailmail-2026-09-14.sql.gz | \
  docker compose exec -T db psql -U snailmail snailmail
```

Test a restore once, into a scratch database, before you need it for real.

## Updating

```bash
cd ~/snail-mail-trail
git pull
docker compose up -d --build
```

If the schema changed, re-run `docker compose exec api node scripts/init-db.js`
— it is safe to run repeatedly.

## Logs

```bash
docker compose logs -f api      # follow
docker compose logs --tail=100 api
```

## Importing your real listings

```bash
docker compose cp clubs.csv api:/app/clubs.csv
docker compose exec api node scripts/import-clubs.js /app/clubs.csv --geocode --approved
```

See [`scripts/README.md`](../scripts/README.md) for the CSV format.
