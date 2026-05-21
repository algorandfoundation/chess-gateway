/**
 * Funds the manager account from the algokit localnet KMD dispenser.
 *
 * Use this once after starting a fresh localnet (`scripts/setup_localnet.sh`)
 * to top up the Vault-held manager key with enough ALGO to sponsor
 * contract deployments and per-user fees + MBR. No-op on non-localnet
 * networks — on testnet/mainnet the manager is expected to be funded
 * out-of-band.
 *
 * Usage:
 *   npx ts-node scripts/fund_manager.ts
 *   yarn api:test:fund-manager
 *
 * Environment variables (same set as the NestJS app):
 *   - NODE_HTTP_SCHEME, NODE_HOST, NODE_PORT, NODE_TOKEN — algod endpoint
 *   - KMD_PORT, KMD_TOKEN — KMD dispenser endpoint (localnet only)
 *   - VAULT_BASE_URL / VAULT_LOCAL_URL, VAULT_NAMESPACE, VAULT_ROLE_ID,
 *     VAULT_SECRET_ID, VAULT_TRANSIT_MANAGERS_PATH, VAULT_MANAGER_KEY —
 *     Vault credentials used to look up the manager's ed25519 public key
 *     (no signing happens — funding the manager doesn't require it).
 *   - GENESIS_ID — used to detect localnet.
 *   - MANAGER_PREFUND_ALGOS — target balance in ALGO (default: 1000).
 */
import 'dotenv/config';
import { Address } from '@algorandfoundation/algokit-utils';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import { VaultService } from '../src/vault/vault.service';
import { buildAlgorandClient, isLocalNet, prefundAccountIfLocalNet } from '../libs/algorand';

async function login(vault: VaultService): Promise<string> {
  const roleId = process.env.VAULT_ROLE_ID;
  const secretId = process.env.VAULT_SECRET_ID;
  if (!roleId || !secretId) throw new Error('VAULT_ROLE_ID / VAULT_SECRET_ID are required');
  return vault.getTokenWithRole(roleId, secretId);
}

async function main(): Promise<void> {
  if (!isLocalNet()) {
    console.log(
      `Skipping KMD prefund: GENESIS_ID=${process.env.GENESIS_ID ?? 'dockernet-v1'} is not a localnet. ` +
        `Fund the manager account out-of-band on testnet/mainnet.`,
    );
    return;
  }

  const config = new ConfigService(process.env);
  // Minimal HttpService wrapper so VaultService works outside Nest's DI.
  const http = { axiosRef: axios.create() } as unknown as HttpService;
  const vault = new VaultService(http, config);

  const vaultToken = await login(vault);
  const managerPubKey = await vault.getManagerPublicKey(vaultToken);
  const managerAddress = new Address(managerPubKey);

  const algorand = buildAlgorandClient();
  const target = Number(process.env.MANAGER_PREFUND_ALGOS ?? '1000');
  console.log(`Funding manager ${managerAddress.toString()} via KMD dispenser to ${target} ALGO`);
  await prefundAccountIfLocalNet(algorand, managerAddress.toString(), target);
  const info = await algorand.account.getInformation(managerAddress.toString());
  console.log(`Manager balance: ${info.balance.algo} ALGO (${info.balance.microAlgo} µALGO)`);
}

main().catch((err) => {
  console.error('fund_manager failed:', err);
  process.exit(1);
});
