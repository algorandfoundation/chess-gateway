import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

/**
 * Resets the Better-Auth sqlite database to a fresh state and seeds it
 * with a small set of demo users:
 *
 *   - manager@example.com  (role: admin)
 *   - alice@example.com    (role: user)
 *   - bob@example.com      (role: user)
 *
 * Steps:
 *   1. Stop-the-world: delete `database.sqlite` so Better Auth re-runs its
 *      migrations on the next gateway start.
 *      NOTE: the gateway must be (re)started after this script runs so the
 *      schema is recreated; the script will wait for the API to be reachable
 *      before posting users.
 *   2. Login to Vault as the manager AppRole and exchange the resulting
 *      vault token for a gateway JWT (`POST /v1/auth/token`).
 *   3. Create each demo user via `POST /v1/auth/user`.
 *
 * Usage:
 *   npx ts-node scripts/seed-users.ts
 *
 * Env overrides:
 *   API_BASE_URL        (default http://localhost:3000)
 *   VAULT_BASE_URL      (default http://localhost:8200)
 *   MANAGER_CREDS_FILE  (default <repo-root>/manager-role-and-secrets.json)
 *   DATABASE_FILE       (default <cwd>/database.sqlite)
 *   SEED_EMAIL_DOMAIN   (default example.com)
 *   SKIP_RESET=1        skip deleting database.sqlite
 */

const VAULT_BASE_URL = process.env.VAULT_BASE_URL || 'http://localhost:8200';
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const MANAGER_CREDS_FILE =
  process.env.MANAGER_CREDS_FILE ||
  path.resolve(process.cwd(), 'manager-role-and-secrets.json');
const DATABASE_FILE =
  process.env.DATABASE_FILE || path.resolve(process.cwd(), 'database.sqlite');
const EMAIL_DOMAIN = process.env.SEED_EMAIL_DOMAIN || 'example.com';

interface ApproleCreds {
  role_id: string;
  secret_id: string;
}

type Role = 'user' | 'manager' | 'admin';
interface SeedUser {
  email: string;
  name: string;
  role: Role;
}

const SEED_USERS: SeedUser[] = [
  { email: `manager@${EMAIL_DOMAIN}`, name: 'Manager', role: 'admin' },
  { email: `alice@${EMAIL_DOMAIN}`, name: 'Alice', role: 'user' },
  { email: `bob@${EMAIL_DOMAIN}`, name: 'Bob', role: 'user' },
];

function readManagerCreds(): ApproleCreds {
  if (!fs.existsSync(MANAGER_CREDS_FILE)) {
    throw new Error(
      `Manager credentials file not found at ${MANAGER_CREDS_FILE}. ` +
        `Run \`npm run vault:development:init\` first.`,
    );
  }
  const parsed = JSON.parse(fs.readFileSync(MANAGER_CREDS_FILE, 'utf-8')) as ApproleCreds;
  if (!parsed.role_id || !parsed.secret_id) {
    throw new Error(`Manager credentials at ${MANAGER_CREDS_FILE} missing role_id/secret_id`);
  }
  return parsed;
}

function resetDatabase() {
  if (process.env.SKIP_RESET === '1') {
    console.log(`SKIP_RESET=1 set; leaving ${DATABASE_FILE} in place.`);
    return;
  }
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${DATABASE_FILE}${suffix}`;
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      console.log(`Removed ${f}`);
    }
  }
  console.log(
    'Database reset. Restart the gateway (`npm run start:dev`) so Better Auth recreates the schema, then re-run this script with SKIP_RESET=1.',
  );
}

async function vaultApproleLogin(creds: ApproleCreds): Promise<string> {
  const response = await axios.post(`${VAULT_BASE_URL}/v1/auth/approle/login`, creds);
  const token = response.data?.auth?.client_token;
  if (!token) {
    throw new Error(`Vault AppRole login did not return a client_token (status=${response.status})`);
  }
  return token;
}

async function apiSignIn(vaultToken: string): Promise<string> {
  const response = await axios.post(`${API_BASE_URL}/v1/auth/token`, {
    vault_token: vaultToken,
  });
  const accessToken = response.data?.access_token;
  if (!accessToken) {
    throw new Error(`API sign-in did not return an access_token (status=${response.status})`);
  }
  return accessToken;
}

async function waitForApi(maxAttempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await axios.get(`${API_BASE_URL}/v1/api`, { validateStatus: () => true });
      return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.warn(`Gateway at ${API_BASE_URL} not reachable yet — proceeding anyway.`);
}

async function createUser(accessToken: string, user: SeedUser) {
  const url = `${API_BASE_URL}/v1/auth/user`;
  try {
    const response = await axios.post(url, user, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const body = err.response?.data;
      throw new Error(
        `Create user "${user.email}" failed (status=${status ?? 'n/a'}): ${err.message} ` +
          `body=${typeof body === 'object' ? JSON.stringify(body) : String(body ?? '')}`,
      );
    }
    throw err;
  }
}

async function main() {
  console.log(`Vault: ${VAULT_BASE_URL}`);
  console.log(`API:   ${API_BASE_URL}`);
  console.log(`Email domain: @${EMAIL_DOMAIN}`);

  resetDatabase();

  const creds = readManagerCreds();
  console.log('Waiting for gateway to be reachable...');
  await waitForApi();

  const vaultToken = await vaultApproleLogin(creds);
  console.log('Vault AppRole login succeeded.');

  const accessToken = await apiSignIn(vaultToken);
  console.log('API sign-in succeeded.');

  for (const user of SEED_USERS) {
    const result = await createUser(accessToken, user);
    console.log(`✔ Created ${user.role.padEnd(7)} ${user.email} -> userId=${result?.userId ?? '?'}`);
  }

  console.log('\nDone. Seeded users:');
  for (const u of SEED_USERS) {
    console.log(`  ${u.role.padEnd(7)} ${u.email}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
