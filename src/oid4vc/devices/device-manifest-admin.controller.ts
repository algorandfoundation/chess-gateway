import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { DeviceManifestService } from './device-manifest.service';

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
  constructor(private readonly deviceManifestService: DeviceManifestService) {}

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
    try {
      const manifest = await this.deviceManifestService.getCurrentByUser(userId);
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
      // Surface a 404 with a structured body rather than the raw
      // service exception so the UI can render a clean "no manifest"
      // empty state.
      if (err instanceof NotFoundException || /no device manifest/i.test(err?.message ?? '')) {
        return {
          userId,
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
