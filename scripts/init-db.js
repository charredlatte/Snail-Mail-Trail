#!/usr/bin/env node
// Create the schema, optionally load sample data, optionally create an admin.
//
//   node scripts/init-db.js                        schema only
//   node scripts/init-db.js --seed                 schema + sample clubs
//   node scripts/init-db.js --admin you@mail.com   schema + an admin account
//
// Re-running is safe: the schema uses IF NOT EXISTS and the seed uses
// ON CONFLICT DO NOTHING.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { pool, queryOne } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const wantSeed = args.includes('--seed');
const adminEmail = args[args.indexOf('--admin') + 1];

async function run(file) {
  await pool.query(await readFile(join(root, 'db', file), 'utf8'));
  console.log(`applied db/${file}`);
}

await run('schema.sql');
if (wantSeed) await run('seed.sql');

if (args.includes('--admin')) {
  if (!adminEmail || adminEmail.startsWith('--')) {
    console.error('--admin needs an email address');
    process.exit(1);
  }
  const email = adminEmail.trim().toLowerCase();

  // Prompted rather than passed as an argument, so the password does not end up
  // in your shell history or in the process list.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = await rl.question(`Password for ${email}: `);
  rl.close();

  if (password.length < 10) {
    console.error('Password must be at least 10 characters.');
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const user = await queryOne(
    `INSERT INTO users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
                                       role = 'admin'
     RETURNING id, email, role`,
    [email, hash, email.split('@')[0]],
  );
  console.log(`admin ready: ${user.email} (id ${user.id})`);
}

await pool.end();
console.log('done');
