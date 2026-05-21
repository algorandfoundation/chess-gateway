/**
 * Deploys a fresh `DIDAlgoStorage` smart contract using the manager
 * key held in Vault as the creator/signer, and persists the resulting
 * application id into Vault KV at
 * `secret/intermezzo/manager/app-id` so the running service picks it
 * up on next boot.
 *
 * Usage:
 *   npx ts-node scripts/deploy-did-algo.ts
 *
 * Environment variables consulted (re-uses the same set of vars as the
 * NestJS app, no separate config required):
 *   - NODE_HTTP_SCHEME, NODE_HOST, NODE_PORT, NODE_TOKEN — algod endpoint
 *     (defaults target an algokit localnet developer setup).
 *   - VAULT_BASE_URL / VAULT_LOCAL_URL, VAULT_NAMESPACE, VAULT_ROLE_ID,
 *     VAULT_SECRET_ID, VAULT_TRANSIT_MANAGERS_PATH, VAULT_MANAGER_KEY —
 *     Vault credentials and transit configuration (signing happens
 *     entirely via Vault transit; no private key ever leaves Vault).
 *   - GENESIS_ID — used to label the deployment.
 *
 * The script idempotently deploys, so re-running it on a network where
 * the contract was already deployed under the same creator/name simply
 * reuses the existing instance.
 */

import 'dotenv/config';
import { Address } from '@algorandfoundation/algokit-utils';
import { DidAlgoStorageFactory } from '../libs/did-algo';
import { VaultService } from '../src/vault/vault.service';
import { ChainService } from '../src/chain/chain.service';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import { buildVaultTransactionSigner } from '../src/did/vault-signer';
import {
  APP_ACCOUNT_BASE_MBR_MICROALGOS,
  buildAlgorandClient,
  prefundAccountIfLocalNet,
  topUpFromSender,
} from '../libs/algorand';
import { MANAGER_APP_ID_KV_PATH } from '../src/did/did.service';

async function login(vault: VaultService): Promise<string> {
  const roleId = process.env.VAULT_ROLE_ID;
  const secretId = process.env.VAULT_SECRET_ID;
  if (!roleId || !secretId) throw new Error('VAULT_ROLE_ID / VAULT_SECRET_ID are required');
  return vault.getTokenWithRole(roleId, secretId);
}

async function main(): Promise<void> {
  const config = new ConfigService(process.env);
  // Minimal HttpService wrapper so VaultService/ChainService work outside Nest's DI.
  const http = { axiosRef: axios.create() } as unknown as HttpService;
  const vault = new VaultService(http, config);
  const chain = new ChainService(config, http);

  const vaultToken = await login(vault);
  const managerPubKey = await vault.getManagerPublicKey(vaultToken);
  const managerAddress = new Address(managerPubKey);

  const algorand = buildAlgorandClient();
  const signer = buildVaultTransactionSigner(chain, (bytes) => vault.signAsManager(bytes, vaultToken));
  algorand.setSigner(managerAddress.toString(), signer);
  algorand.setDefaultSigner(signer);

  const factory = new DidAlgoStorageFactory({
    algorand,
    defaultSender: managerAddress.toString(),
    defaultSigner: signer,
  });

  await prefundAccountIfLocalNet(
    algorand,
    managerAddress.toString(),
    Number(process.env.MANAGER_PREFUND_ALGOS ?? '1000'),
  );

  console.log(`Deploying DIDAlgoStorage to ${process.env.NODE_HOST ?? 'localhost'} as ${managerAddress.toString()}`);
  // We don't configure an indexer client (algokit localnet exposes one on
  // :8980 but the public algonode endpoints don't), so we short-circuit
  // AppDeployer's existing-deployment lookup by passing an empty cache.
  // This means the script always issues a fresh `create` — re-running it
  // produces a new app id rather than reusing a previously deployed one.
  const { result, appClient } = await factory.deploy({
    onUpdate: 'append',
    onSchemaBreak: 'append',
    existingDeployments: {
      creator: managerAddress,
      apps: {},
    },
  });

  console.log(`Operation: ${result.operationPerformed}`);
  console.log(`App ID:    ${appClient.appId}`);
  console.log(`App addr:  ${appClient.appAddress}`);

  // Fund the contract account from the manager with just its base
  // MBR (0.1 ALGO). Per-box MBR is paid inline as part of each
  // `upload` group, so no extra slack is needed here.
  await topUpFromSender(algorand, managerAddress, appClient.appAddress, APP_ACCOUNT_BASE_MBR_MICROALGOS);

  await vault.kvWrite(MANAGER_APP_ID_KV_PATH, { appId: appClient.appId.toString() }, vaultToken);
  console.log('');
  console.log(`Persisted appId=${appClient.appId} to Vault KV at ${MANAGER_APP_ID_KV_PATH}`);
}

main().catch((err) => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
