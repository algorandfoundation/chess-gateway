import { Controller, Get, Post, Body, BadRequestException, UseGuards } from '@nestjs/common';
import { LinkService } from './link.service';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiCookieAuth } from '@nestjs/swagger';
import { AuthGuard as BetterAuthGuard, OptionalAuth, Session } from '@thallesp/nestjs-better-auth';
import { Public } from '../auth/constants';
import { LinkResponseDto, ChallengeResponseDto } from './link.dto';
import type { LinkSession } from './link.types';

@ApiTags('Link')
@Controller('link')
export class LinkController {
  constructor(private readonly linkService: LinkService) {}

  /**
   * Generates a unique challenge for app integrity verification.
   * This challenge should be used by the mobile app when requesting attestation.
   */
  @Public()
  @Get('challenge')
  @UseGuards(BetterAuthGuard)
  @ApiOperation({ summary: 'Get a challenge for app integrity verification' })
  @ApiResponse({ status: 200, type: ChallengeResponseDto })
  @ApiCookieAuth()
  async getChallenge(@Session() session: LinkSession): Promise<ChallengeResponseDto> {
    const challenge = await this.linkService.generateChallenge();
    session.challenge = challenge;
    return { challenge };
  }

  /**
   * Links a device and wallet in a single operation.
   * Verifies app integrity, associates the authenticated user with their vault player,
   * and links the provided wallet address.
   */
  @Public()
  @Post('response')
  @UseGuards(BetterAuthGuard)
  @ApiOperation({ summary: 'Link device and wallet (integrity response)' })
  @ApiBody({ type: LinkResponseDto })
  @ApiResponse({ status: 200, description: 'Device and wallet linked successfully.' })
  @ApiResponse({ status: 400, description: 'Integrity verification failed or email not verified.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  @ApiResponse({ status: 404, description: 'User email not found in player directory.' })
  @ApiCookieAuth()
  async linkResponse(@Session() session: LinkSession, @Body() body: LinkResponseDto) {
    if (!session?.user?.emailVerified) {
      throw new BadRequestException('Email must be verified to link device and wallet.');
    }

    const { walletAddress, ...integrityData } = body;
    const challenge = session.challenge;

    if (!challenge) {
      throw new BadRequestException('No challenge found for this session. Please request a challenge first.');
    }

    const email = session.user.email;

    return this.linkService.linkResponse(session.user.id, email, walletAddress, integrityData, challenge);
  }

  /**
   * Retrieves the current session information, including user details,
   * account mapping, and vault player information.
   * If no mapping exists but an email is available, it attempts to auto-associate.
   */
  @Public()
  @OptionalAuth()
  @Get('session')
  @UseGuards(BetterAuthGuard)
  @ApiOperation({ summary: 'Get current session and mapping' })
  @ApiResponse({ status: 200, description: 'Session details retrieved.' })
  async getSession(@Session() session: LinkSession) {
    if (!session) return { authenticated: false };

    let verification = await this.linkService.getLinkVerification(session.user.id);
    if (!verification && session.user.email) {
      verification = await this.linkService.autoAssociate(session.user.id, session.user.email);
    }

    let player = null;
    if (verification) {
      player = await this.linkService.getVaultPlayer(verification.id);
    }

    return {
      authenticated: true,
      user: session.user,
      verification,
      player,
    };
  }
}
