import { AlgorandClient, Address, algo, microAlgo } from '@algorandfoundation/algokit-utils';
import { ClientManager } from '@algorandfoundation/algokit-utils/types/client-manager';

/**
 * Default base MBR funding for a freshly-deployed application's
 * escrow account: 0.1 ALGO — the protocol-minimum account balance.
 * The DIDAlgoStorage contract pays per-box MBR inline via a payment
 * transaction grouped with each `upload`, so the app account itself
 * only needs to satisfy the account base MBR.
 */
export const APP_ACCOUNT_BASE_MBR_MICROALGOS = 100_000n;

export function isLocalNet(): boolean {
  const genesisId = process.env.GENESIS_ID ?? 'dockernet-v1';
  return ClientManager.genesisIdIsLocalNet(genesisId);
}

export function buildAlgorandClient(): AlgorandClient {
  const scheme = process.env.NODE_HTTP_SCHEME ?? 'http';
  const host = process.env.NODE_HOST ?? 'localhost';
  const port = process.env.NODE_PORT ?? '4001';
  const token = process.env.NODE_TOKEN ?? 'a'.repeat(64);
  const algodConfig = { server: `${scheme}://${host}`, port: Number(port), token };

  if (isLocalNet()) {
    const kmdPort = process.env.KMD_PORT ?? '4002';
    const kmdToken = process.env.KMD_TOKEN ?? token;
    return AlgorandClient.fromConfig({
      algodConfig,
      kmdConfig: { server: `${scheme}://${host}`, port: Number(kmdPort), token: kmdToken },
    });
  }
  return AlgorandClient.fromConfig({ algodConfig });
}

export async function prefundAccountIfLocalNet(
  algorand: AlgorandClient,
  address: string | Address,
  amountAlgos = 1000,
): Promise<void> {
  if (!isLocalNet()) return;
  const target = algo(amountAlgos);

  let currentMicroAlgos = 0n;
  try {
    const info = await algorand.account.getInformation(address);
    currentMicroAlgos = BigInt(info.balance.microAlgo);
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    if (status !== 404) throw err;
  }

  if (currentMicroAlgos >= BigInt(target.microAlgo)) {
    return;
  }

  const dispenser = await algorand.account.localNetDispenser();
  console.log(`Prefunding account ${address} with ${target.algo} ALGO from localnet dispenser`);
  await algorand.send.payment({
    sender: dispenser.toString(),
    receiver: address,
    amount: target,
    signer: dispenser.signer,
  });
}

/**
 * Top up `receiver` from the supplied `sender` (the manager) with the
 * minimum µAlgo amount required so that the receiver's balance is at
 * least `targetMicroAlgos`. If the receiver is already at or above the
 * target, this is a no-op.
 *
 * Unlike {@link prefundAccountIfLocalNet}, this runs on every network
 * (the manager is expected to be funded everywhere, not just localnet)
 * and pays only the exact shortfall — never an inflated round number —
 * so neither the operator nor a localnet dispenser is on the hook for
 * costs that aren't strictly required to bring the receiver to the
 * target MBR.
 */
export async function topUpFromSender(
  algorand: AlgorandClient,
  sender: string | Address,
  receiver: string | Address,
  targetMicroAlgos: bigint,
): Promise<void> {
  let currentMicroAlgos = 0n;
  try {
    const info = await algorand.account.getInformation(receiver);
    currentMicroAlgos = BigInt(info.balance.microAlgo);
  } catch (err: unknown) {
    const e = err as { status?: number; response?: { status?: number } };
    const status = e?.status ?? e?.response?.status;
    if (status !== 404) throw err;
  }

  if (currentMicroAlgos >= targetMicroAlgos) return;

  const shortfall = targetMicroAlgos - currentMicroAlgos;
  console.log(
    `Funding ${receiver.toString()} with ${shortfall} µALGO from ${sender.toString()} ` +
      `(current=${currentMicroAlgos}, target=${targetMicroAlgos})`,
  );
  await algorand.send.payment({
    sender: sender.toString(),
    receiver,
    amount: microAlgo(Number(shortfall)),
  });
}
