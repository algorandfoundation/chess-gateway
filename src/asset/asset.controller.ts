import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AssetService } from './asset.service';
import { AssetInfoDto } from './asset-info.dto';

@ApiBearerAuth()
@Controller()
@ApiUnauthorizedResponse({ description: 'Unauthorized' })
export class AssetController {
  constructor(private readonly assetService: AssetService) {}

  // Endpoint to fetch on-chain ASA params (name, unit-name, decimals, total, addresses, ...)
  @Get('asset/:asset_id')
  @ApiOperation({
    summary: 'Get Asset Info',
    description:
      'Fetch on-chain parameters for an Algorand Standard Asset (ASA) by its numeric `asset_id`. ' +
      'Mirrors algod `GET /v2/assets/{asset-id}`.',
  })
  @ApiOkResponse({
    description: 'The asset params have been successfully fetched.',
    type: AssetInfoDto,
  })
  @ApiNotFoundResponse({ description: 'Asset not found.' })
  @ApiBadRequestResponse({ description: 'Bad Request' })
  async assetInfo(@Param('asset_id') asset_id: string): Promise<AssetInfoDto> {
    const id = Number(asset_id);
    if (!Number.isFinite(id) || id < 0) {
      throw new NotFoundException(`Asset id ${asset_id} is not a valid number`);
    }
    const info = await this.assetService.getAssetInfo(id);
    if (!info) {
      throw new NotFoundException(`Asset ${asset_id} not found`);
    }
    return info as AssetInfoDto;
  }
}
