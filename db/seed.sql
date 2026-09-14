-- SAMPLE DATA -- every club below is fictional.
--
-- These exist so you can run the API and see search, price filtering and the
-- map working before you have collected any real listings. The city
-- coordinates are real, the clubs are not. Replace them with genuine listings
-- using scripts/import-clubs.js, then delete this file's rows:
--
--   DELETE FROM clubs WHERE slug LIKE 'sample-%';

INSERT INTO tags (slug, name) VALUES
  ('postcard',    'Postcard'),
  ('penpal',      'Pen Pal'),
  ('stationery',  'Stationery'),
  ('zine',        'Zine'),
  ('art-mail',    'Art Mail'),
  ('mail-art',    'Mail Art'),
  ('subscription','Subscription Box'),
  ('beginner',    'Beginner Friendly'),
  ('lgbtq',       'LGBTQ+'),
  ('kids',        'Kids & Family')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO clubs
  (slug, name, description, url, price_cents, price_currency, price_period,
   country_code, region, city, lat, lng, ships_worldwide, status)
VALUES
  ('sample-columbus-postcard-swap', 'Columbus Postcard Swap',
   'Monthly postcard exchange for central Ohio. Beginners welcome, no minimum.',
   'https://example.com/columbus-postcard-swap',
   500, 'USD', 'monthly', 'US', 'Ohio', 'Columbus', 39.9612, -82.9988, false, 'approved'),

  ('sample-brooklyn-zine-post', 'Brooklyn Zine Post',
   'Quarterly zine trade by mail. Each round pairs you with three other makers.',
   'https://example.com/brooklyn-zine-post',
   3600, 'USD', 'quarterly', 'US', 'New York', 'Brooklyn', 40.6782, -73.9442, false, 'approved'),

  ('sample-portland-stationery-society', 'Portland Stationery Society',
   'Letter writing socials plus a yearly stationery parcel.',
   'https://example.com/portland-stationery-society',
   9000, 'USD', 'yearly', 'US', 'Oregon', 'Portland', 45.5152, -122.6784, false, 'approved'),

  ('sample-austin-mail-art-collective', 'Austin Mail Art Collective',
   'Pay per swap. Send art, get art. No subscription, no commitment.',
   'https://example.com/austin-mail-art',
   800, 'USD', 'per_swap', 'US', 'Texas', 'Austin', 30.2672, -97.7431, false, 'approved'),

  ('sample-dayton-letter-league', 'Dayton Letter League',
   'Free community pen pal matching for southwest Ohio.',
   'https://example.com/dayton-letter-league',
   0, 'USD', 'free', 'US', 'Ohio', 'Dayton', 39.7589, -84.1916, false, 'approved'),

  ('sample-san-francisco-snail-society', 'San Francisco Snail Society',
   'Bay Area letter writers. Monthly prompts and a stamp swap.',
   'https://example.com/sf-snail-society',
   1200, 'USD', 'monthly', 'US', 'California', 'San Francisco', 37.7749, -122.4194, false, 'approved'),

  ('sample-chicago-kids-pen-pals', 'Chicago Kids Pen Pals',
   'Supervised pen pal program for ages 7-14, run through local libraries.',
   'https://example.com/chicago-kids-pen-pals',
   0, 'USD', 'free', 'US', 'Illinois', 'Chicago', 41.8781, -87.6298, false, 'approved'),

  ('sample-london-letterbox-club', 'London Letterbox Club',
   'Monthly stationery parcel posted anywhere in the world.',
   'https://example.com/london-letterbox',
   1400, 'GBP', 'monthly', 'GB', 'England', 'London', 51.5074, -0.1278, true, 'approved'),

  ('sample-berlin-brieffreunde', 'Berlin Brieffreunde',
   'German and English pen pal matching, one-time joining fee.',
   'https://example.com/berlin-brieffreunde',
   2000, 'EUR', 'one_time', 'DE', 'Berlin', 'Berlin', 52.5200, 13.4050, true, 'approved'),

  ('sample-kyoto-tegami-circle', 'Kyoto Tegami Circle',
   'Seasonal letter sets and washi tape, posted internationally.',
   'https://example.com/kyoto-tegami',
   250000, 'JPY', 'yearly', 'JP', 'Kyoto', 'Kyoto', 35.0116, 135.7681, true, 'approved'),

  ('sample-toronto-queer-quills', 'Toronto Queer Quills',
   'LGBTQ+ letter writing circle. Sliding scale, pay what you can.',
   'https://example.com/toronto-queer-quills',
   600, 'CAD', 'monthly', 'CA', 'Ontario', 'Toronto', 43.6532, -79.3832, false, 'approved'),

  ('sample-melbourne-post-haste', 'Melbourne Post Haste',
   'Postcards and small parcels, worldwide members welcome.',
   'https://example.com/melbourne-post-haste',
   1800, 'AUD', 'monthly', 'AU', 'Victoria', 'Melbourne', -37.8136, 144.9631, true, 'approved'),

  ('sample-pending-example', 'Example Pending Submission',
   'Sits in the moderation queue so you can see the admin flow working.',
   'https://example.com/pending',
   1000, 'USD', 'monthly', 'US', 'Ohio', 'Cleveland', 41.4993, -81.6944, false, 'pending'),

  ('sample-pending-example-2', 'Second Pending Submission',
   'A second queued entry, so you can practise rejecting one as well as approving.',
   'https://example.com/pending-two',
   1500, 'USD', 'monthly', 'US', 'Michigan', 'Detroit', 42.3314, -83.0458, false, 'pending')
ON CONFLICT (slug) DO NOTHING;

-- Categorise the samples.
INSERT INTO club_tags (club_id, tag_id)
SELECT c.id, t.id FROM clubs c, tags t WHERE (c.slug, t.slug) IN (
  ('sample-columbus-postcard-swap',       'postcard'),
  ('sample-columbus-postcard-swap',       'beginner'),
  ('sample-brooklyn-zine-post',           'zine'),
  ('sample-brooklyn-zine-post',           'art-mail'),
  ('sample-portland-stationery-society',  'stationery'),
  ('sample-portland-stationery-society',  'subscription'),
  ('sample-austin-mail-art-collective',   'mail-art'),
  ('sample-austin-mail-art-collective',   'art-mail'),
  ('sample-dayton-letter-league',         'penpal'),
  ('sample-dayton-letter-league',         'beginner'),
  ('sample-san-francisco-snail-society',  'penpal'),
  ('sample-san-francisco-snail-society',  'stationery'),
  ('sample-chicago-kids-pen-pals',        'penpal'),
  ('sample-chicago-kids-pen-pals',        'kids'),
  ('sample-london-letterbox-club',        'stationery'),
  ('sample-london-letterbox-club',        'subscription'),
  ('sample-berlin-brieffreunde',          'penpal'),
  ('sample-kyoto-tegami-circle',          'stationery'),
  ('sample-kyoto-tegami-circle',          'subscription'),
  ('sample-toronto-queer-quills',         'penpal'),
  ('sample-toronto-queer-quills',         'lgbtq'),
  ('sample-melbourne-post-haste',         'postcard')
) ON CONFLICT DO NOTHING;
