import {
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseBoolPipe,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Public } from '../auth/constants';
import { DidAlreadyPublishedError, DidService } from './did.service';
import { DidRecord } from './entities/did-record.entity';
import { DidRecordResponseDto } from './dto/did-record-response.dto';
import { DidPublishResponseDto } from './dto/did-publish-response.dto';

/**
 * CRUD endpoints for DID documents managed by this service.
 *
 * - **Create** (`POST /did/users/:user_id`) publishes the user's DID document
 *   on the configured `did:algo` registry, signed by the manager's
 *   Vault-backed key. Returns 409 if a document already exists on chain;
 *   pass `?force=true` to delete the existing document (reclaiming MBR)
 *   and republish a fresh one atomically.
 * - **Read single** (`GET /did/users/:user_id`) returns the locally cached
 *   document and publication state. Public so external relying parties can
 *   resolve a known user without a chain round-trip.
 * - **Read list** (`GET /did/users`) enumerates every cached record — useful
 *   for ops dashboards and retry tooling.
 * - **Delete** (`DELETE /did/users/:user_id`) tears down the on-chain DID
 *   document via the contract's `startDelete` / `deleteData` flow
 *   (reclaiming all box MBR back to the manager) and drops the local
 *   cache row.
 *
 * The wallet module continues to call `DidService` directly during user
 * creation so the publish lifecycle stays inside this module.
 */
@ApiTags('DID')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Unauthorized' })
@Controller('did')
export class DidController {
  constructor(private readonly didService: DidService) {}

  /**
   * Publish a DID document for a user. Fails with 409 if a document
   * already exists on chain; pass `?force=true` to delete the existing
   * document (reclaiming MBR) before republishing. Any on-chain failure
   * is propagated as a 5xx — we never persist a `failed` cache row.
   */
  @Post('users/:user_id')
  @ApiOperation({
    summary: 'Publish (or force-republish) a user DID document',
    description:
      'Resolves the user public key from Vault, builds a W3C DID document, and publishes it on the configured `did:algo` registry signed by the manager key. Returns 409 if a document already exists on chain unless `force=true` is passed, which deletes the existing document (reclaiming MBR) before republishing.',
  })
  @ApiQuery({
    name: 'force',
    required: false,
    type: Boolean,
    description:
      'When true, delete an existing on-chain DID document for this user (reclaiming the box MBR back to the manager) and then publish a fresh one. When false or omitted, the request fails with 409 if a document already exists.',
  })
  @ApiCreatedResponse({ description: 'Publication attempted.', type: DidPublishResponseDto })
  @ApiConflictResponse({ description: 'A DID document already exists for the user; pass `force=true` to republish.' })
  async publish(
    @Request() request: any,
    @Param('user_id') user_id: string,
    @Query('force', new ParseBoolPipe({ optional: true })) force?: boolean,
  ): Promise<DidPublishResponseDto> {
    try {
      const result = await this.didService.publishForUser(user_id, request.vault_token, { force });
      return {
        did: result.did,
        document: result.document,
        txIds: result.txIds,
      };
    } catch (err) {
      if (err instanceof DidAlreadyPublishedError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  /**
   * Returns the locally cached DID document and publication state for a user.
   * Returns 404 if no record exists; consumers should then fall back to the
   * universal resolver.
   *
   * Public so external services (e.g. universal resolver drivers) can read
   * the cache without an AppRole token.
   */
  @Public()
  @Get('users/:user_id')
  @ApiOperation({ summary: 'Resolve a user DID document from the local cache' })
  @ApiOkResponse({ description: 'DID record found.', type: DidRecordResponseDto })
  @ApiNotFoundResponse({ description: 'No DID record cached for the user.' })
  async resolveUser(@Param('user_id') user_id: string): Promise<DidRecordResponseDto> {
    const record = await this.didService.resolveLocal(user_id);
    if (!record) throw new NotFoundException('No DID record found for user');
    return DidController.toResponse(record);
  }

  /**
   * List every cached DID record. Authenticated — intended for management
   * tooling, not the public resolver surface.
   */
  @Get('users')
  @ApiOperation({ summary: 'List every locally cached DID record' })
  @ApiOkResponse({ description: 'All cached DID records.', type: [DidRecordResponseDto] })
  async listRecords(): Promise<DidRecordResponseDto[]> {
    const records = await this.didService.listRecords();
    return records.map(DidController.toResponse);
  }

  /**
   * Tear down the user's on-chain DID document via the contract's
   * `startDelete` / `deleteData` flow (reclaiming all box MBR back to
   * the manager) and drop the local cache row. Returns 404 only when
   * neither the on-chain document nor the local cache row existed.
   */
  @Delete('users/:user_id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete the on-chain DID document and local cache for a user',
    description:
      "Runs the contract's `startDelete` / `deleteData` sequence (sequentially deleting every data box and finally the metadata box), reclaiming all box MBR back to the manager, then drops the local resolver entry.",
  })
  @ApiNoContentResponse({ description: 'Document removed (on chain and locally).' })
  @ApiNotFoundResponse({ description: 'No on-chain or cached DID record for the user.' })
  async deleteRecord(@Request() request: any, @Param('user_id') user_id: string): Promise<void> {
    const { txIds, cacheRemoved } = await this.didService.deleteUserDid(user_id, request.vault_token);
    if (txIds === null && !cacheRemoved) {
      throw new NotFoundException('No DID record found for user');
    }
  }

  private static toResponse(record: DidRecord): DidRecordResponseDto {
    return {
      userId: record.user_id,
      did: record.did,
      network: record.network,
      appId: record.app_id,
      document: JSON.parse(record.document),
      txIds: record.tx_ids ? record.tx_ids.split(',') : [],
      updatedAt: record.updated_at,
    };
  }
}
