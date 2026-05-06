import { ApiProperty } from '@nestjs/swagger';

/**
 * Result of a publish (or republish) request. Mirrors `PublishedDidInfo`
 * from `DidService` but expressed as a class for Swagger.
 */
export class DidPublishResponseDto {
  @ApiProperty({ description: 'Fully-qualified did:algo identifier of the published document.' })
  did: string;

  @ApiProperty({ description: 'W3C DID document that was published.', type: Object })
  document: object;

  @ApiProperty({
    description: 'Confirmed transaction ids from this publish run.',
    type: [String],
  })
  txIds: string[];
}
