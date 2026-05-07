import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard as BetterAuthGuard, Session } from '@thallesp/nestjs-better-auth';

import { Public } from '../../auth/constants';
import { DeviceManifestService } from './device-manifest.service';
import {
  DeviceManifestResponseDto,
  UploadDeviceManifestDto,
} from '../dto/upload-device-manifest.dto';
import { Oid4vcUserDeviceManifest } from '../entities/oid4vc-user-device-manifest.entity';
import type { LinkSession } from '../../link/link.types';

/**
 * Sync surface for the wallet's `did:key` device manifest.
 *
 * Tier 1 of the sync model documented in `src/oid4vc/DISCOVERY.md`:
 * the wallet POSTs the entire signed DID Document on every structural
 * change. The first manifest must be seeded via the link-attestation
 * flow (`POST /v1/link/response`), which is the only place an unknown
 * `didKey` is accepted; after that, this endpoint accepts updates from
 * the same authenticated user.
 *
 * **Out of scope for this iteration (TODO):** pre-issuance freshness
 * check (Tier 3). The OID4VCI issuer does not yet require a fresh
 * manifest signature in the credential request.
 */
@ApiTags('oid4vc-device-manifest')
@Controller('oid4vc/devices')
@Public()
@UseGuards(BetterAuthGuard)
@ApiCookieAuth()
export class DeviceManifestController {
  constructor(private readonly deviceManifestService: DeviceManifestService) {}

  @Post('manifest')
  @ApiOperation({
    summary:
      'Upload a new signed device manifest revision. Requires the manifest to have been seeded via /link/response first.',
  })
  @ApiResponse({ status: 201, type: DeviceManifestResponseDto })
  @ApiResponse({ status: 400, description: 'Malformed manifest or signature mismatch.' })
  @ApiResponse({ status: 403, description: 'didKey is not seeded for this user, or manifest revoked.' })
  @ApiResponse({ status: 409, description: 'version is older than the currently-stored revision.' })
  async upload(
    @Session() session: LinkSession,
    @Body() body: UploadDeviceManifestDto,
  ): Promise<DeviceManifestResponseDto> {
    if (!session?.user?.id) {
      // BetterAuthGuard normally enforces this, but be explicit.
      throw new BadRequestException('Authenticated session required');
    }

    const { manifest, revision } = await this.deviceManifestService.upsertManifest({
      userId: session.user.id,
      didKey: body.didKey,
      version: body.version,
      signedAt: body.signedAt,
      didDocument: body.didDocument,
      signature: body.signature,
      // Non-seed path: require the manifest to already exist.
      trustedSeed: false,
    });

    return toResponse(manifest, revision.id, revision.version);
  }

  @Get('manifest')
  @ApiOperation({
    summary:
      'Return the current device manifest for the authenticated user (defaults to the only one if there is just one).',
  })
  @ApiResponse({ status: 200, type: DeviceManifestResponseDto })
  @ApiResponse({ status: 404, description: 'No manifest seeded for this user.' })
  async getCurrent(@Session() session: LinkSession): Promise<DeviceManifestResponseDto> {
    if (!session?.user?.id) {
      throw new BadRequestException('Authenticated session required');
    }
    const manifest = await this.deviceManifestService.getCurrentByUser(session.user.id);
    return toResponse(
      manifest,
      manifest.currentRevisionId ?? '',
      manifest.currentRevision?.version ?? 0,
    );
  }

  @Get('manifest/:didKey')
  @ApiOperation({
    summary:
      'Return the manifest for the given didKey if it belongs to the authenticated user. Used by the wallet for the periodic safety-net sync.',
  })
  @ApiResponse({ status: 200, type: DeviceManifestResponseDto })
  @ApiResponse({ status: 404, description: 'No manifest for this user/didKey.' })
  async getByDidKey(
    @Session() session: LinkSession,
    @Param('didKey') didKey: string,
  ): Promise<DeviceManifestResponseDto> {
    if (!session?.user?.id) {
      throw new BadRequestException('Authenticated session required');
    }
    const manifest = await this.deviceManifestService.getCurrentByUser(session.user.id, didKey);
    return toResponse(
      manifest,
      manifest.currentRevisionId ?? '',
      manifest.currentRevision?.version ?? 0,
    );
  }
}

function toResponse(
  manifest: Oid4vcUserDeviceManifest,
  revisionId: string,
  version: number,
): DeviceManifestResponseDto {
  return {
    manifestId: manifest.id,
    didKey: manifest.didKey,
    userId: manifest.userId,
    version,
    revisionId,
    revokedAt: manifest.revokedAt ? manifest.revokedAt.toISOString() : null,
  };
}
