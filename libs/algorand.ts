import { AlgorandClient, Address, algo } from '@algorandfoundation/algokit-utils';
import { ClientManager } from '@algorandfoundation/algokit-utils/types/client-manager';

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
