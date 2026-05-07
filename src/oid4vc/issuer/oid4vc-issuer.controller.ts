import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard as BetterAuthGuard, Session } from '@thallesp/nestjs-better-auth';
import { Public } from '../../auth/constants';
import { AuthService } from '../../auth/auth.service';

import { Oid4vcIssuerService, DEFAULT_CREDENTIAL_CONFIGURATIONS } from './oid4vc-issuer.service';
import {
  CreateCredentialOfferDto,
  CredentialOfferResponseDto,
  CreateSelfOfferDto,
  HolderDidResponseDto,
} from '../dto/create-credential-offer.dto';
import { Oid4vcIssuanceSession } from '../entities/oid4vc-issuance-session.entity';
import { Oid4vcAgentProvider } from '../agent/oid4vc-agent.provider';
import type { LinkSession } from '../../link/link.types';

/**
 * HTTP surface for OID4VCI session orchestration.
 *
 * This controller is responsible for the *application-side* of issuance:
 * creating offers (so the front-end can render a QR code) and inspecting
 * sessions. The OID4VCI protocol endpoints themselves (token, credential,
 * credential offer fetch) are exposed by Credo on its own Express router,
 * mounted under `OID4VC_ISSUER_PATH` in `main.ts`.
 */
@ApiTags('oid4vc-issuer')
@Controller('oid4vc/issuer')
export class Oid4vcIssuerController {
  constructor(
    private readonly issuer: Oid4vcIssuerService,
    private readonly authService: AuthService,
    private readonly agentProvider: Oid4vcAgentProvider,
  ) {}

  @Get('credential-configurations')
  @ApiOperation({
    summary: 'Returns the credential configurations advertised by this issuer (sd-jwt-vc, jwt-vc).',
  })
  listCredentialConfigurations() {
    return DEFAULT_CREDENTIAL_CONFIGURATIONS;
  }

  @Post('offers')
  @ApiOperation({ summary: 'Create a pre-authorized OID4VCI credential offer.' })
  async createOffer(@Body() dto: CreateCredentialOfferDto): Promise<CredentialOfferResponseDto> {
    const session = await this.issuer.createOffer({
      credentialConfigurationIds: dto.credentialConfigurationIds,
      userId: dto.userId,
      issuanceMetadata: dto.issuanceMetadata,
    });
    const holderDid = (await this.agentProvider.resolveUserAlgoDid(dto.userId)) ?? undefined;
    return toResponse(session, holderDid);
  }

  /**
   * Returns the authenticated user's `did:algo`. The wallet uses this to
   * build the OID4VCI proof JWT `kid` (`<did>#keys-2`) and `iss` claims.
   *
   * The platform `userId` Better-Auth knows about is *not* the same as the
   * vault player id under which the on-chain DID is keyed (e.g. the user's
   * email is `bob@example.com`, the player id is `bob`); this endpoint
   * resolves the mapping centrally so wallets don't have to reimplement it.
   */
  @Public()
  @Get('me')
  @UseGuards(BetterAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      'Resolve the authenticated user to their vault player id and on-chain `did:algo` so the ' +
      'wallet can build OID4VCI holder-binding proof JWTs.',
  })
  async getMyHolderDid(@Session() session: LinkSession): Promise<HolderDidResponseDto> {
    const playerId = await this.requirePlayerId(session);
    const did = await this.agentProvider.resolveUserAlgoDid(playerId);
    if (!did) {
      throw new NotFoundException(
        `No on-chain did:algo found for player ${playerId}. Has the user been linked yet?`,
      );
    }
    return { playerId, did };
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List all locally-tracked issuance sessions.' })
  async listSessions(): Promise<Oid4vcIssuanceSession[]> {
    return this.issuer.listSessions();
  }

  @Get('sessions/:id')
  @ApiOperation({ summary: 'Get a single issuance session by local id.' })
  async getSession(@Param('id') id: string): Promise<Oid4vcIssuanceSession> {
    return this.issuer.findSession(id);
  }

  /**
   * Demo / developer endpoint: mint a pre-authorized credential offer for the
   * authenticated user. Lets the wallet (or a browser-side demo page) request
   * a fresh QR code without going through the manager flow.
   *
   * The endpoint is intentionally guarded by the same session auth used for
   * link/manifest, so the resulting credential is bound to the user's
   * `did:algo` exactly as a manager-issued offer would be.
   */
  @Public()
  @Post('demo/self-offer')
  @UseGuards(BetterAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      'Create a pre-authorized credential offer for the authenticated user. Demo endpoint used by the wallet to import a credential locally.',
  })
  async createSelfOffer(
    @Session() session: LinkSession,
    @Body() dto: CreateSelfOfferDto,
  ): Promise<CredentialOfferResponseDto> {
    const playerId = await this.requirePlayerId(session);
    const requested = dto.credentialConfigurationIds?.length
      ? dto.credentialConfigurationIds
      : ['credential-sd-jwt'];
    const issuanceSession = await this.issuer.createOffer({
      credentialConfigurationIds: requested,
      userId: playerId,
      issuanceMetadata: dto.issuanceMetadata,
    });
    const holderDid = (await this.agentProvider.resolveUserAlgoDid(playerId)) ?? undefined;
    return toResponse(issuanceSession, holderDid);
  }

  /**
   * Resolve the Better-Auth session to the vault *player id* under which the
   * on-chain DID document is keyed. Better-Auth's `user.id` is the auth-store
   * primary key (e.g. `03nd2qeacxtlm79uyhkekd9`), whereas the platform DID
   * registry — and `LinkService` — operate on the player id derived from the
   * user's email (e.g. `bob@example.com` → `bob`). Without this resolution
   * the issuer would mint offers tied to a userId that has no `did:algo`
   * record, and the wallet's holder-binding proof JWT would have no public
   * key to verify against.
   */
  private async requirePlayerId(session: LinkSession): Promise<string> {
    const email = session?.user?.email;
    if (!email) {
      throw new BadRequestException('Authenticated session with an email is required');
    }
    const playerId = await this.authService.getUserIdByEmail(email);
    if (!playerId) {
      throw new NotFoundException(`No vault player mapped to email ${email}`);
    }
    return playerId;
  }
}

function toResponse(
  session: Oid4vcIssuanceSession,
  holderDid?: string,
): CredentialOfferResponseDto {
  return {
    id: session.id,
    credoIssuanceSessionId: session.credoIssuanceSessionId ?? '',
    credentialOffer: session.credentialOffer,
    state: session.state,
    holderDid,
  };
}
