import { ApiProperty } from '@nestjs/swagger';

/**
 * On-chain ASA params, mirroring algod `GET /v2/assets/{asset-id}`.
 * Kept narrow on purpose — we only document the fields the UI consumes.
 */
export class AssetParamsDto {
  @ApiProperty({ required: false }) name?: string;
  @ApiProperty({ required: false, name: 'unit-name' }) 'unit-name'?: string;
  @ApiProperty({ required: false }) decimals?: number;
  @ApiProperty({ required: false, type: String }) total?: number | string;
  @ApiProperty({ required: false }) creator?: string;
  @ApiProperty({ required: false }) url?: string;
  @ApiProperty({ required: false }) manager?: string;
  @ApiProperty({ required: false }) reserve?: string;
  @ApiProperty({ required: false }) freeze?: string;
  @ApiProperty({ required: false }) clawback?: string;
  @ApiProperty({ required: false, name: 'default-frozen' }) 'default-frozen'?: boolean;
  @ApiProperty({ required: false, name: 'metadata-hash' }) 'metadata-hash'?: string;
}

export class AssetInfoDto {
  @ApiProperty({ description: 'Numeric ASA id.' })
  index!: number;

  @ApiProperty({ type: AssetParamsDto })
  params!: AssetParamsDto;
}
