import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiCookieAuth } from '@nestjs/swagger';
import { AuthGuard as BetterAuthGuard, Session } from '@thallesp/nestjs-better-auth';
import { Public } from '../../auth/constants';
import { SponsoredClaimAssetRequestDto, SponsoredClaimAssetResponseDto } from './sponsored.dto';
import type { LinkSession } from '../link.types';
import { SponsoredService } from './sponsored.service';

@ApiTags('Sponsored')
@Controller('link/sponsored')
export class SponsoredController {
  constructor(private readonly sponsoredService: SponsoredService) {}

  @Public()
  @Post('claim-asset')
  @UseGuards(BetterAuthGuard)
  @ApiOperation({
    summary: 'Claim assets to linked wallet (sponsored fees)',
    description:
      "Transfers assets from the caller's vault-managed account to their linked wallet address. " +
      'All transaction fees are covered by the sponsor - the user pays nothing.',
  })
  @ApiBody({ type: SponsoredClaimAssetRequestDto })
  @ApiResponse({ status: 201, type: SponsoredClaimAssetResponseDto })
  @ApiResponse({ status: 400, description: 'Missing or invalid linked wallet/account state.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  @ApiCookieAuth()
  async claimAsset(
    @Session() session: LinkSession,
    @Body() body: SponsoredClaimAssetRequestDto,
  ): Promise<SponsoredClaimAssetResponseDto> {
    return {
      transaction_id: await this.sponsoredService.claimAsset(
        session.user.id,
        body.assetId,
        body.amount,
        body.lease,
        body.note,
      ),
    };
  }
}
