import { Injectable } from '@nestjs/common';
import { ChainService } from '../chain/chain.service';
import { AssetInfoResponse } from '../chain/algo-node-responses';

/**
 * Thin wrapper around `ChainService.getAssetInfo` so the asset module
 * can grow its own concerns (caching, enrichment, off-chain metadata,
 * ...) without touching `ChainService` or piggybacking on the wallet
 * module.
 */
@Injectable()
export class AssetService {
  constructor(private readonly chainService: ChainService) {}

  /**
   * Fetch the full on-chain ASA params for a single asset id.
   * Returns `null` when the asset doesn't exist (algod 404).
   */
  async getAssetInfo(asset_id: number | bigint): Promise<AssetInfoResponse | null> {
    return this.chainService.getAssetInfo(asset_id);
  }
}
