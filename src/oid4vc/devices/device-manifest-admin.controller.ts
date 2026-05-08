import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { DeviceManifestService } from './device-manifest.service';
import { VerificationService } from '../../link/verification/verification.service';
import { DidService } from '../../did/did.service';

/**
 * Manager-facing admin surface for device manifests.
 *
 * Distinct from `DeviceManifestController`:
 *   - That controller is `@Public()` and authenticated by the
 *     better-auth session cookie (the wallet posts manifests there).
 *   - This controller is *not* `@Public()`, so the global JWT guard
 *     applies and only callers holding a manager-scoped JWT can hit
 *     it.
 *
 * Used by the Intermezzo manager UI to render any user's current
 * manifest + DID Document.
 */
@ApiTags('oid4vc-device-manifest-admin')
@Controller('oid4vc/admin')
export class DeviceManifestAdminController {
  constructor(
    private readonly deviceManifestService: DeviceManifestService,
    private readonly verificationService: VerificationService,
    private readonly didService: DidService,
  ) {}

  @ApiBearerAuth()
  @Get('manifest/:userId')
  @ApiOperation({
    summary:
      "Return the current device manifest + DID Document for an arbitrary user (manager view).",
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        didKey: { type: 'string' },
        version: { type: 'number' },
        revisionId: { type: 'string' },
        signedAt: { type: 'string', format: 'date-time' },
        revokedAt: { type: 'string', format: 'date-time', nullable: true },
        didDocument: { type: 'object', additionalProperties: true },
      },
    },
  })
  async getByUser(@Param('userId') userId: string) {
    // The path-param can be either the Better-Auth user id or the
    // vault user id (e.g. `alice`). Manifests are keyed by the
    // Better-Auth `userId`, so resolve through the LinkVerification
    // mapping before querying.
    const authUserId = await this.verificationService.resolveAuthUserId(userId);

    try {
      const manifest = await this.deviceManifestService.getCurrentByUser(authUserId);
      const revision = manifest.currentRevision;
      return {
        userId: manifest.userId,
        didKey: manifest.didKey,
        version: revision?.version ?? null,
        revisionId: manifest.currentRevisionId ?? null,
        signedAt: revision?.signedAt ? revision.signedAt.toISOString() : null,
        revokedAt: manifest.revokedAt ? manifest.revokedAt.toISOString() : null,
        didDocument: revision?.document ?? null,
      };
    } catch (err: any) {
      if (err instanceof NotFoundException || /no device manifest/i.test(err?.message ?? '')) {
        // No device manifest yet — fall back to the on-chain DID
        // document cached locally (`DidRecord`). Managers commonly
        // publish a DID document well before any device attestation
        // has happened, and the UI should still render that doc.
        const didRecord = await this.didService.resolveLocal(userId);
        if (didRecord) {
          let parsedDoc: Record<string, unknown> | null = null;
          try {
            parsedDoc = JSON.parse(didRecord.document) as Record<string, unknown>;
          } catch {
            parsedDoc = null;
          }
          return {
            userId: authUserId,
            didKey: didRecord.did,
            version: null,
            revisionId: null,
            signedAt: didRecord.updated_at ? didRecord.updated_at.toISOString() : null,
            revokedAt: null,
            didDocument: parsedDoc,
          };
        }
        // Neither manifest nor on-chain DID — return the empty
        // structure so the UI can render the "no manifest" state.
        return {
          userId: authUserId,
          didKey: null,
          version: null,
          revisionId: null,
          signedAt: null,
          revokedAt: null,
          didDocument: null,
        };
      }
      throw err;
    }
  }
}
