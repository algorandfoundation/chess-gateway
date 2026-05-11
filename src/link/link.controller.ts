import { Controller, Get, Post, Body, BadRequestException, UseGuards, Logger, Query, Request } from '@nestjs/common';
import { LinkService } from './link.service';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiCookieAuth, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AuthGuard as BetterAuthGuard, OptionalAuth, Session } from '@thallesp/nestjs-better-auth';
import { Public } from '../auth/constants';
import { LinkResponseDto, ChallengeResponseDto, OtpLookupResponseDto } from './link.dto';
import type { LinkSession } from './link.types';
import { auth } from './auth';

@ApiTags('Link')
@Controller('link')
export class LinkController {
  private readonly logger = new Logger(LinkController.name);

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

    // Persist the challenge on the better-auth session row so it can be verified
    // on a subsequent /response request. Mutating the in-memory `session` object
    // is not enough — better-auth reloads the session from storage on each request,
    // so we must write through the internal adapter.
    const ctx = await auth.$context;
    await ctx.internalAdapter.updateSession(session.session.token, { challenge });

    this.logger.log(
      `getChallenge: issued challenge for sessionId=${session?.session?.id} userId=${session?.user?.id} challenge=${challenge}`,
    );
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
    this.logger.log(
      `linkResponse: incoming request sessionId=${session?.session?.id} userId=${session?.user?.id} email=${session?.user?.email} emailVerified=${session?.user?.emailVerified} hasChallengeInSession=${!!session?.session?.challenge}`,
    );
    this.logger.log(`linkResponse: session=${JSON.stringify(session)}`);

    if (!session?.user?.emailVerified) {
      this.logger.warn(
        `linkResponse: email not verified sessionId=${session?.session?.id} userId=${session?.user?.id}`,
      );
      throw new BadRequestException('Email must be verified to link device and wallet.');
    }

    const { walletAddress, ...integrityData } = body;
    const challenge = session.session.challenge;

    if (!challenge) {
      this.logger.warn(
        `linkResponse: no challenge found in session sessionId=${session?.session?.id} userId=${session?.user?.id}. ` +
          `This typically indicates the session does not match the one used for /challenge ` +
          `(e.g. mobile app cookies are not being persisted/sent between requests).`,
      );
      throw new BadRequestException('No challenge found for this session. Please request a challenge first.');
    }

    this.logger.log(
      `linkResponse: challenge found in session sessionId=${session?.session?.id} userId=${session?.user?.id} challenge=${challenge}`,
    );

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

  /**
   * @deprecated Demo / development helper. Returns the latest OTP issued to a
   * given email/type pair so a manager can complete the sign-in flow when
   * stdout/logs aren't accessible (e.g. live demos). Requires a manager
   * Algorand Vault token in the `Authorization` header — the global
   * `AuthGuard` extracts `vault_token` from the JWT, and `LinkService`
   * verifies the token has manager-approle access by reading the managers
   * transit key. Do **NOT** enable this endpoint in production.
   */
  @Get('otp')
  @ApiBearerAuth()
  @ApiOperation({
    summary: '[DEPRECATED] Look up the latest OTP for a registered user (manager only)',
    description:
      'Returns the most recent OTP issued by Better Auth for the given email and type. ' +
      'Guarded by the manager Vault approle. Intended for demos/development only — do not enable in production.',
    deprecated: true,
  })
  @ApiQuery({ name: 'email', required: true, description: 'Email the OTP was issued for' })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'OTP type: sign-in (default), email-verification, or forget-password',
  })
  @ApiResponse({ status: 200, type: OtpLookupResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token.' })
  @ApiResponse({ status: 403, description: 'The provided token does not have manager-role access.' })
  @ApiResponse({ status: 404, description: 'No OTP exists for that email/type.' })
  async getOtp(
    @Request() request: any,
    @Query('email') email: string,
    @Query('type') type = 'sign-in',
  ): Promise<OtpLookupResponseDto> {
    if (!email) {
      throw new BadRequestException('Query parameter `email` is required.');
    }
    this.logger.warn(`getOtp (deprecated): manager OTP lookup for email=${email} type=${type}`);
    return this.linkService.getOtpForManager(email, type, request.vault_token);
  }
}
