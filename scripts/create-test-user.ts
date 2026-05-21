import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

/**
 * End-to-end smoke test that drives the live API the same way an external
 * client would:
 *
 *   1. Read the manager AppRole credentials from `manager-role-and-secrets.json`.
 *   2. Exchange them for a Vault `client_token` via Vault's AppRole login.
 *   3. Sign in to the pawn API (`POST /v1/auth/sign-in/`) to obtain a JWT.
 *   4. Create a new user "jim" (`POST /v1/wallet/user/`), which also triggers
 *      the on-chain DID publication for the user.
 *   5. Read back the cached DID record (`GET /v1/did/identities/jim`) and print it.
 *
 * The script fails (non-zero exit) on any HTTP error or missing DID record so
 * it can be wired into CI / local smoke checks.
 */

const VAULT_BASE_URL = process.env.VAULT_BASE_URL || 'http://localhost:8200';
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const MANAGER_CREDS_FILE =
  process.env.MANAGER_CREDS_FILE || path.resolve(process.cwd(), 'manager-role-and-secrets.json');
const TEST_USER_ID = process.env.TEST_USER_ID || 'jim';

interface ApproleCreds {
  role_id: string;
  secret_id: string;
}

async function vaultApproleLogin(creds: ApproleCreds): Promise<string> {
  const url = `${VAULT_BASE_URL}/v1/auth/approle/login`;
  const response = await axios.post(url, creds);
  const token = response.data?.auth?.client_token;
  if (!token) {
    throw new Error(`Vault AppRole login did not return a client_token (status=${response.status})`);
  }
  return token;
}

async function apiSignIn(vaultToken: string): Promise<string> {
  const url = `${API_BASE_URL}/v1/auth/sign-in/`;
  const response = await axios.post(url, { vault_token: vaultToken });
  const accessToken = response.data?.access_token;
  if (!accessToken) {
    throw new Error(`API sign-in did not return an access_token (status=${response.status})`);
  }
  return accessToken;
}

async function createUser(accessToken: string, userId: string) {
  const url = `${API_BASE_URL}/v1/wallet/user/`;
  const response = await axios.post(url, { user_id: userId }, { headers: { Authorization: `Bearer ${accessToken}` } });
  return response.data;
}

async function fetchDidRecord(accessToken: string, userId: string) {
  const url = `${API_BASE_URL}/v1/did/identities/${encodeURIComponent(userId)}`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.data;
}

function readManagerCreds(): ApproleCreds {
  if (!fs.existsSync(MANAGER_CREDS_FILE)) {
    throw new Error(
      `Manager credentials file not found at ${MANAGER_CREDS_FILE}. ` + `Run \`yarn vault:development:init\` first.`,
    );
  }
  const raw = fs.readFileSync(MANAGER_CREDS_FILE, 'utf-8');
  const parsed = JSON.parse(raw) as ApproleCreds;
  if (!parsed.role_id || !parsed.secret_id) {
    throw new Error(`Manager credentials file ${MANAGER_CREDS_FILE} is missing role_id/secret_id`);
  }
  return parsed;
}

function describeAxiosError(label: string, err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data;
    const body = typeof data === 'object' ? JSON.stringify(data) : String(data ?? '');
    return `${label} failed (status=${status ?? 'n/a'}): ${err.message}${body ? ` body=${body}` : ''}`;
  }
  return `${label} failed: ${(err as Error)?.message ?? String(err)}`;
}

async function main() {
  console.log(`Using Vault at ${VAULT_BASE_URL}`);
  console.log(`Using API   at ${API_BASE_URL}`);
  console.log(`Test user ID: ${TEST_USER_ID}`);

  const creds = readManagerCreds();

  let vaultToken: string;
  try {
    vaultToken = await vaultApproleLogin(creds);
  } catch (err) {
    throw new Error(describeAxiosError('Vault AppRole login', err));
  }
  console.log('Vault AppRole login succeeded.');

  let accessToken: string;
  try {
    accessToken = await apiSignIn(vaultToken);
  } catch (err) {
    throw new Error(describeAxiosError('API sign-in', err));
  }
  console.log('API sign-in succeeded.');

  let userInfo: any;
  try {
    userInfo = await createUser(accessToken, TEST_USER_ID);
  } catch (err) {
    throw new Error(describeAxiosError(`Create user "${TEST_USER_ID}"`, err));
  }
  console.log(`Created user "${TEST_USER_ID}":`);
  console.log(JSON.stringify(userInfo, null, 2));

  if (!userInfo?.did?.did) {
    throw new Error(`Created user response did not include a DID record. Response: ${JSON.stringify(userInfo)}`);
  }
  if (userInfo.did.status !== 'published') {
    throw new Error(`User created but DID status is "${userInfo.did.status}" (error: ${userInfo.did.error ?? 'n/a'})`);
  }

  let didRecord: any;
  try {
    didRecord = await fetchDidRecord(accessToken, TEST_USER_ID);
  } catch (err) {
    throw new Error(describeAxiosError(`Fetch DID record for "${TEST_USER_ID}"`, err));
  }
  console.log(`DID record for "${TEST_USER_ID}":`);
  console.log(JSON.stringify(didRecord, null, 2));

  console.log(`\n✔ API smoke test passed: user "${TEST_USER_ID}" created with DID ${didRecord.did}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
