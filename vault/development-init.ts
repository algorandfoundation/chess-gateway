import 'dotenv/config';
import * as fs from 'fs';
import axios from 'axios';
import assert from 'assert';
import SQLite from 'better-sqlite3';
import * as path from 'path';
import { Address } from '@algorandfoundation/algokit-utils';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { DidAlgoStorageFactory } from '../libs/did-algo';
import { buildAlgorandClient, prefundAccountIfLocalNet } from '../libs/algorand';
import { VaultService } from '../src/vault/vault.service';
import { ChainService } from '../src/chain/chain.service';
import { buildVaultTransactionSigner } from '../src/did/vault-signer';
import { updateEnvFile } from '../libs/env';

// Constants
const VAULT_BASE_URL = process.env.VAULT_BASE_URL || 'http://localhost:8200';
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const VAULT_INIT_ENDPOINT = '/v1/sys/init';
const VAULT_UNSEAL_ENDPOINT = '/v1/sys/unseal';
const VAULT_MOUNTS_ENDPOINT = '/v1/sys/mounts';
const VAULT_TRANSIT_USERS_PATH = process.env.VAULT_TRANSIT_USERS_PATH || 'pawn/users';
const VAULT_TRANSIT_MANAGERS_PATH = process.env.VAULT_TRANSIT_MANAGERS_PATH || 'pawn/managers';
const VAULT_MANAGER_KEY = process.env.VAULT_MANAGER_KEY || 'manager';
const VAULT_SEAL_KEYS_FILE = 'vault-seal-keys.json';

const MANAGERS_ROLE_AND_SECRET_KEYS_FILE = 'manager-role-and-secrets.json';
const MANAGER_ADDRESS_FILE = 'manager-address.txt';
const USERS_ROLE_AND_SECRET_KEYS_FILE = 'user-role-and-secrets.json';
const USERS_POLICY_NAME = 'pawn_users_policy';
const USERS_APP_ROLE_NAME = 'pawn_users_approle';
const MANAGERS_POLICY_NAME = 'pawn_managers_policy';
const MANAGERS_APP_ROLE_NAME = 'pawn_managers_approle';

// Vault `/v1/sys/health` status codes — see
// https://developer.hashicorp.com/vault/api-docs/system/health
type VaultHealth = {
  initialized: boolean;
  sealed: boolean;
};

// Query Vault's health endpoint to determine the actual server state, rather
// than inferring it from the local presence of `vault-seal-keys.json`. The
// health endpoint intentionally returns non-2xx codes for not-initialized /
// sealed / standby — we explicitly accept any status so we can read the body.
async function getVaultHealth(): Promise<VaultHealth> {
  // Vault may not be listening yet when this script first runs (the container
  // is up but the HTTP server hasn't bound the port). Retry transient
  // connection errors for up to ~60s before giving up.
  const maxAttempts = 60;
  const delayMs = 1000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.get(`${VAULT_BASE_URL}/v1/sys/health`, {
        validateStatus: () => true,
        timeout: 2000,
      });
      return {
        initialized: !!response.data?.initialized,
        sealed: !!response.data?.sealed,
      };
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code;
      const isTransient =
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        code === 'EAI_AGAIN' ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT';
      if (!isTransient) throw error;
      if (attempt === 1 || attempt % 5 === 0) {
        console.log(`Waiting for Vault to be reachable (attempt ${attempt}/${maxAttempts})...`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// Function to initialize Vault
async function initVault() {
  try {
    // Initialize Vault
    const response = await axios.post(`${VAULT_BASE_URL}${VAULT_INIT_ENDPOINT}`, {
      secret_shares: 1,
      secret_threshold: 1,
    });

    // Save seal keys to file
    fs.writeFileSync(VAULT_SEAL_KEYS_FILE, JSON.stringify(response.data));

    // Unseal Vault
    await unsealVault(response.data.keys[0], response.data.root_token);

    // Initialize transit engine
    await initUsersTransitEngine(response.data.root_token);
    await initManagersTransitEngine(response.data.root_token);

    console.log('Vault Token:', response.data.root_token);

    return response.data;
  } catch (error) {
    console.error('Failed to initialize Vault:', error);
    throw error;
  }
}

// Function to unseal Vault
async function unsealVault(key: string, token: string) {
  try {
    // Unseal Vault
    const response = await axios.post(
      `${VAULT_BASE_URL}${VAULT_UNSEAL_ENDPOINT}`,
      {
        secret_shares: 1,
        key,
      },
      {
        headers: {
          'X-Vault-Token': token,
        },
      },
    );

    // Check if Vault is unsealed
    if (response.data.sealed) {
      throw new Error('Vault is not unsealed');
    }

    console.log('Vault is unsealed');
  } catch (error) {
    console.error('Failed to unseal Vault:', error);
  }
}

// Function to initialize transit engine
async function initUsersTransitEngine(token: string) {
  try {
    // Get mounts
    const mountsResponse = await axios.get(`${VAULT_BASE_URL}${VAULT_MOUNTS_ENDPOINT}`, {
      headers: {
        'X-Vault-Token': token,
      },
    });

    console.log('Mounts:', JSON.stringify(mountsResponse.data));

    // Mount transit engine
    const mountResponse = await axios.post(
      `${VAULT_BASE_URL}${VAULT_MOUNTS_ENDPOINT}/${VAULT_TRANSIT_USERS_PATH}`,
      {
        type: 'transit',
        config: {
          force_no_cache: true,
        },
      },
      {
        headers: {
          'X-Vault-Token': token,
        },
      },
    );

    console.log('Mount transit engine response:', JSON.stringify(mountResponse.data));
  } catch (error) {
    console.error('Failed to initialize transit engine:', error);
  }
}

// Function to initialize manager transit engine
async function initManagersTransitEngine(token: string) {
  try {
    // Get mounts
    const mountsResponse = await axios.get(`${VAULT_BASE_URL}${VAULT_MOUNTS_ENDPOINT}`, {
      headers: {
        'X-Vault-Token': token,
      },
    });

    console.log('Mounts:', JSON.stringify(mountsResponse.data));

    // Mount transit engine
    const mountResponse = await axios.post(
      `${VAULT_BASE_URL}${VAULT_MOUNTS_ENDPOINT}/${VAULT_TRANSIT_MANAGERS_PATH}`,
      {
        type: 'transit',
        config: {
          force_no_cache: true,
        },
      },
      {
        headers: {
          'X-Vault-Token': token,
        },
      },
    );

    console.log('Mount transit engine response:', JSON.stringify(mountResponse.data));
  } catch (error) {
    console.error('Failed to initialize transit engine:', error);
  }
}

// Function to create ACL policies in Vault
async function createACLPolicies(token: string) {
  try {
    // Define the ACL policies
    const policies = {
      // https://developer.hashicorp.com/vault/api-docs/secret/transit

      [USERS_POLICY_NAME]: {
        path: {
          // USER
          // -------
          // 1) allow /keys/* path
          // 2) but exclude config paths like /keys/*/config
          [`${VAULT_TRANSIT_USERS_PATH}/keys/*`]: {
            capabilities: ['create', 'read', 'update'],
          },
          [`${VAULT_TRANSIT_USERS_PATH}/keys/+/+`]: {
            capabilities: ['deny'],
          },
        },
      },
      [MANAGERS_POLICY_NAME]: {
        path: {
          // MANAGER
          // -------
          // 1) allow /keys/* path
          // 2) but exclude config paths like /keys/*/config
          [`${VAULT_TRANSIT_MANAGERS_PATH}/keys/*`]: {
            capabilities: ['create', 'read', 'update'],
          },
          [`${VAULT_TRANSIT_MANAGERS_PATH}/keys/+/+`]: {
            capabilities: ['deny'],
          },
          // 3 allow /sign path
          [`${VAULT_TRANSIT_MANAGERS_PATH}/sign/*`]: {
            capabilities: ['create', 'read', 'update'],
          },

          // USER
          // -------
          // 1) allow /keys/* path
          // 2) but exclude config paths like /keys/*/config
          [`${VAULT_TRANSIT_USERS_PATH}/keys/*`]: {
            capabilities: ['create', 'read', 'update'],
          },
          [`${VAULT_TRANSIT_USERS_PATH}/keys/+/+`]: {
            capabilities: ['deny'],
          },
          // 3) allow list users
          [`${VAULT_TRANSIT_USERS_PATH}/keys`]: {
            capabilities: ['list'],
          },
          // 4 allow /sign path
          [`${VAULT_TRANSIT_USERS_PATH}/sign/*`]: {
            capabilities: ['create', 'read', 'update'],
          },
        },
      },
    };

    // Create the ACL policies
    for (const [policyName, policy] of Object.entries(policies)) {
      const policyExists = await checkACLPoliciesExists(policyName, token);
      if (!policyExists) {
        await axios.put(
          `${VAULT_BASE_URL}/v1/sys/policies/acl/${policyName}`,
          {
            policy: JSON.stringify(policy),
          },
          {
            headers: {
              'X-Vault-Token': token,
            },
          },
        );
        console.log(`ACL policy '${policyName}' created successfully`);
      } else {
        console.log(`PASS: ACL policy '${policyName}' already exists`);
      }
    }
  } catch (error) {
    console.error('Failed to create ACL policies:', error);
  }
}

async function checkACLPoliciesExists(policyName: string, token: string): Promise<boolean> {
  try {
    await axios.get(`${VAULT_BASE_URL}/v1/sys/policies/acl/${policyName}`, {
      headers: {
        'X-Vault-Token': token,
      },
    });
    return true; // Policy exists if the GET request is successful
  } catch (error: any) {
    if (error.response && error.response.status === 404) {
      return false; // Policy does not exist if 404 is returned
    }
    console.error(`Failed to check ACL policy '${policyName}':`, error);
    return false; // Assume policy does not exist or error during check
  }
}
async function enableAppRoleIfNotEnabledAuth(root_token: string) {
  try {
    const response = await axios.post(
      `${VAULT_BASE_URL}/v1/sys/auth/approle`,
      {
        type: 'approle',
      },
      {
        headers: {
          'X-Vault-Token': root_token,
        },
      },
    );

    if (response.status === 204 || response.status === 200) {
      console.log('AppRole authentication enabled successfully');
    } else {
      throw new Error(`Unexpected response status: ${response.status}`);
    }
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 400 &&
      error.response.data.errors[0].includes('path is already in use')
    ) {
      console.log('PASS: AppRole authentication is already enabled');
    } else {
      console.error('Failed to enable AppRole authentication:', error);
    }
  }
}

// Function to generate AppRoles for the ACL policies
async function checkAppRoleExists(roleName: string, root_token: string): Promise<boolean> {
  try {
    await axios.get(`${VAULT_BASE_URL}/v1/auth/approle/role/${roleName}`, {
      headers: {
        'X-Vault-Token': root_token,
      },
    });
    return true; // Role exists if the GET request is successful
  } catch (error: any) {
    if (error.response && error.response.status === 404) {
      return false; // Role does not exist if 404 is returned
    }
    console.error(`Failed to check AppRole '${roleName}':`, error);
    return false; // Assume role does not exist or error during check
  }
}

async function getOrCreateAppRoles(root_token: string) {
  const appRoles = [
    {
      name: USERS_APP_ROLE_NAME,
      policies: [USERS_POLICY_NAME],
    },
    {
      name: MANAGERS_APP_ROLE_NAME,
      policies: [MANAGERS_POLICY_NAME],
    },
  ];

  for (const appRole of appRoles) {
    const roleExists = await checkAppRoleExists(appRole.name, root_token);
    if (!roleExists) {
      await axios.post(
        `${VAULT_BASE_URL}/v1/auth/approle/role/${appRole.name}`,
        {
          policies: appRole.policies,
          token_type: 'batch',
        },
        {
          headers: {
            'X-Vault-Token': root_token,
          },
        },
      );
      console.log(`AppRole '${appRole.name}' created successfully`);
    } else {
      console.log(`PASS: AppRole '${appRole.name}' already exists`);
    }
  }
}

async function logRoleIdAndSecretId(role_name: string, token: string, store_file_name: string) {
  // Get role_id
  const roleIdResponse = await axios.get(`${VAULT_BASE_URL}/v1/auth/approle/role/${role_name}/role-id`, {
    headers: {
      'X-Vault-Token': token,
    },
  });
  const role_id = roleIdResponse.data.data.role_id;

  // Get secret_id
  const secretIdResponse = await axios.post(
    `${VAULT_BASE_URL}/v1/auth/approle/role/${role_name}/secret-id`,
    {},
    {
      headers: {
        'X-Vault-Token': token,
      },
    },
  );
  const secret_id = secretIdResponse.data.data.secret_id;

  fs.writeFileSync(
    store_file_name,
    JSON.stringify({
      role_id,
      secret_id,
    }),
  );

  console.log(`\n${role_name}' - Role ID:    ->\t`, role_id);
  console.log(`'${role_name}' - Secret ID: ->\t`, secret_id);
  console.log(
    `You can get vault token ('auth.client_token') using \n\nPOST ${VAULT_BASE_URL}/v1/auth/approle/login\n{\n  "role_id": "${role_id}",\n  "secret_id": "${secret_id}"\n}\n`,
  );
}

async function getOrCreateKey(transitPath: string, keyName: string, token: string): Promise<Uint8Array> {
  const url: string = `${VAULT_BASE_URL}/v1/${transitPath}/keys/${keyName}`;
  // Vault transit POST /keys/{name} returns 204 No Content on success (create or idempotent re-create).
  const createResponse = await axios.post(
    url,
    {
      type: 'ed25519',
      derived: false,
      allow_deletion: false,
    },
    {
      headers: { 'X-Vault-Token': token },
      validateStatus: (s) => s === 200 || s === 204,
    },
  );
  assert(createResponse.status === 200 || createResponse.status === 204);

  // Fetch the key material in a separate GET (POST does not return the public key).
  const readResponse = await axios.get(url, {
    headers: { 'X-Vault-Token': token },
  });
  assert(readResponse.status === 200);

  const publicKey = new Address(Buffer.from(response.data.data.keys['1'].public_key, 'base64')).toString();
  // Persist the manager Algorand address so external tooling (e.g. CI) can
  // prefund it from a LocalNet dispenser without having to re-derive it.
  fs.writeFileSync(MANAGER_ADDRESS_FILE, publicKey);
  console.log('Manager public key: \n', publicKey);
  const publicKeyBytes = Buffer.from(readResponse.data.data.keys['1'].public_key, 'base64');
  const publicKey = new Address(publicKeyBytes).toString();
  console.log(`${keyName} public key (${transitPath}): \n`, publicKey);

  return new Uint8Array(publicKeyBytes);
}

async function getOrCreateManager(token: string): Promise<Uint8Array> {
  return await getOrCreateKey(VAULT_TRANSIT_MANAGERS_PATH, VAULT_MANAGER_KEY, token);
}

async function getOrCreateUser(name: string, token: string): Promise<Uint8Array> {
  return await getOrCreateKey(VAULT_TRANSIT_USERS_PATH, name, token);
}

// Function to get Vault status
async function getVaultStatus() {
  try {
    const response = await axios.get(`${VAULT_BASE_URL}/v1/sys/health`, {
      validateStatus: (status) => status < 600,
    });
    return response.data;
  } catch (error) {
    console.error('Failed to check Vault health:', error);
    return null;
  }
}

// Main function
async function main() {
  // Decide what to do based on Vault's actual server state, not on the
  // local presence of `vault-seal-keys.json`. Inferring from the file alone
  // is fragile: if Vault file storage was persisted from a previous run
  // (e.g. `volumes/vault/file/`) but the seal-keys file isn't on disk,
  // `POST /v1/sys/init` returns 400 "Vault is already initialized" and the
  // script crashes downstream trying to read `sealKeys.root_token`.
  const health = await getVaultHealth();
  const sealKeysFileExists = fs.existsSync(VAULT_SEAL_KEYS_FILE);

  let sealKeys: any;
  if (!health.initialized) {
    // Fresh Vault — initialize and persist seal keys.
    sealKeys = await initVault();
  } else if (sealKeysFileExists) {
    // Already initialized and we have the seal keys locally — just unseal
    // (idempotent if already unsealed) and proceed.
    sealKeys = JSON.parse(fs.readFileSync(VAULT_SEAL_KEYS_FILE).toString());
    if (health.sealed) {
      await unsealVault(sealKeys.keys[0], sealKeys.root_token);
    }
  } else {
    // Initialized but seal keys are missing — we cannot unseal or
    // authenticate. This usually means stale Vault file storage was
    // carried over from a previous run. Surface a clear error instead of
    // crashing on `undefined.root_token`.
    throw new Error(
      `Vault is already initialized but '${VAULT_SEAL_KEYS_FILE}' is not present. ` +
        `This typically means stale Vault file storage exists from a previous run. ` +
        `Reset by removing the persisted storage (e.g. 'rm -rf volumes/vault') and ` +
        `recreating the vault container, then re-run this script.`,
    );
  }

  console.log('\n\n------------\nVault Root Token:\n', sealKeys.root_token, '\n------------\n\n');

  await createACLPolicies(sealKeys.root_token);
  await enableAppRoleIfNotEnabledAuth(sealKeys.root_token);
  await getOrCreateAppRoles(sealKeys.root_token);
  console.log('\n\n\nUSER SECRETS\n-----');
  await logRoleIdAndSecretId(USERS_APP_ROLE_NAME, sealKeys.root_token, USERS_ROLE_AND_SECRET_KEYS_FILE);
  console.log('\n\n\nMANAGER SECRETS\n-----');
  await logRoleIdAndSecretId(MANAGERS_APP_ROLE_NAME, sealKeys.root_token, MANAGERS_ROLE_AND_SECRET_KEYS_FILE);

  console.log('\n\n\nMANAGER ALGORAND PUBLIC ADDRESS\n------');
  const managerPubKey = await getOrCreateManager(sealKeys.root_token);
  const managerAddress = new Address(managerPubKey);

  // Setup services and signer
  const config = new ConfigService(process.env);
  const http = { axiosRef: axios.create() } as unknown as HttpService;
  const vault = new VaultService(http, config);
  const chain = new ChainService(config, http);
  const signer = buildVaultTransactionSigner(chain, (bytes) => vault.signAsManager(bytes, sealKeys.root_token));

  const algorand = buildAlgorandClient();
  algorand.setSigner(managerAddress, signer);
  algorand.setDefaultSigner(signer);

  // 1. Prefund Manager
  await prefundAccountIfLocalNet(algorand, managerAddress, 1000);

  console.log('\n\n\nDEVELOPMENT USERS\n------');
  await getOrCreateUser('alice', sealKeys.root_token);
  await getOrCreateUser('bob', sealKeys.root_token);
  await getOrCreateUser('charlie', sealKeys.root_token);

  // Application check / deployment
  let appId = process.env.DID_ALGO_APP_ID;
  let appFound = false;

  if (appId && appId !== '0' && appId !== '1337') {
    try {
      const appInfo = await algorand.app.getById(BigInt(appId));
      if (appInfo.creator.toString() !== managerAddress.toString()) {
        console.error('\nERROR: Existing contract found but the manager has changed.');
        console.error(`Contract App ID ${appId} was created by ${appInfo.creator}`);
        console.error(`Current Vault Manager address is ${managerAddress.toString()}`);
        console.error('\nPlease run: algokit localnet reset');
        process.exit(1);
      }
      console.log(`PASS: DIDAlgoStorage Application ${appId} is owned by the current manager.`);
      appFound = true;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      console.warn(`\nWARNING: Could not find DID_ALGO_APP_ID ${appId}. Triggering deployment...`);
    }
  }

  if (!appFound) {
    console.log('\nDeploying new DIDAlgoStorage application...');

    const factory = new DidAlgoStorageFactory({
      algorand,
      defaultSender: managerAddress,
      defaultSigner: signer,
    });

    const { appClient } = await factory.deploy({
      onUpdate: 'append',
      onSchemaBreak: 'append',
      existingDeployments: {
        creator: managerAddress,
        apps: {},
      },
    });

    appId = appClient.appId.toString();
    console.log(`Successfully deployed DIDAlgoStorage. App ID: ${appId}`);

    // 2. Fund the contract address
    await prefundAccountIfLocalNet(algorand, appClient.appAddress, 1000);

    updateEnvFile('DID_ALGO_APP_ID', appId);
    process.env.DID_ALGO_APP_ID = appId;
  }

  // Database initialization for development users
  const dbPath = path.join(process.cwd(), 'database.sqlite');
  console.log(`\nInitializing development users in database: ${dbPath}`);
  const db = new SQLite(dbPath);
  const now = new Date().toISOString();

  // Alice: registered user to the sql database without a DID.
  db.prepare(
    `
    INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run('alice', 'Alice', 'alice@example.com', 1, now, now);
  console.log('Alice registered in database (no DID)');
  db.close();

  // Bob: publish a DID via the live API, mirroring how a real client would.
  // The pawn container runs both this init script and the API on the same
  // host, so we hit `API_BASE_URL` (defaults to http://localhost:3000) using
  // the manager AppRole credentials we just wrote to disk.
  const managerCreds = JSON.parse(fs.readFileSync(MANAGERS_ROLE_AND_SECRET_KEYS_FILE).toString()) as {
    role_id: string;
    secret_id: string;
  };

  await waitForApi(API_BASE_URL);

  console.log(`\nLogging into API to publish DID for Bob via ${API_BASE_URL}...`);
  const apiVaultToken = await vaultApproleLogin(managerCreds);
  const accessToken = await apiSignIn(apiVaultToken);
  const bobInfo = await createUserViaApi(accessToken, 'bob');
  console.log(`Bob created via API. did=${bobInfo?.did ?? 'null'} address=${bobInfo?.public_address ?? 'n/a'}`);
  if (!bobInfo?.did) {
    throw new Error(`Expected DID for Bob in API response, got: ${JSON.stringify(bobInfo)}`);
  }
}

async function vaultApproleLogin(creds: { role_id: string; secret_id: string }): Promise<string> {
  const response = await axios.post(`${VAULT_BASE_URL}/v1/auth/approle/login`, creds);
  const token = response.data?.auth?.client_token;
  if (!token) {
    throw new Error(`Vault AppRole login did not return a client_token (status=${response.status})`);
  }
  return token;
}

async function apiSignIn(vaultToken: string): Promise<string> {
  const response = await axios.post(`${API_BASE_URL}/v1/auth/sign-in/`, { vault_token: vaultToken });
  const accessToken = response.data?.access_token;
  if (!accessToken) {
    throw new Error(`API sign-in did not return an access_token (status=${response.status})`);
  }
  return accessToken;
}

async function createUserViaApi(accessToken: string, userId: string): Promise<any> {
  const response = await axios.post(
    `${API_BASE_URL}/v1/wallet/user/`,
    { user_id: userId },
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return response.data;
}

async function waitForApi(baseUrl: string, attempts = 60, delayMs = 1000): Promise<void> {
  const url = `${baseUrl}/v1/auth/sign-in/`;
  for (let i = 0; i < attempts; i++) {
    try {
      // We expect 4xx (missing body / bad token) once the server is up — that's fine,
      // we just want to know the HTTP listener is accepting connections.
      await axios.post(url, {}, { validateStatus: () => true, timeout: 1500 });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`API at ${baseUrl} did not become reachable after ${attempts} attempts`);
}

// Run main function
main().catch((error) => {
  console.error('Vault development init failed:', error);
  process.exit(1);
});
