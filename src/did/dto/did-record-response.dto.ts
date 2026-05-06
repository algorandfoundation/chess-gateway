import { ApiProperty } from '@nestjs/swagger';

/**
 * Public projection of a cached DID record. Mirrors the fields exposed
 * by the local resolver while hiding internal storage concerns (e.g.
 * the raw JSON string in the `document` column is parsed into an object).
 */
export class DidRecordResponseDto {
  @ApiProperty({ description: 'Vault user id this record belongs to.' })
  userId: string;

  @ApiProperty({ description: 'Fully-qualified did:algo identifier.' })
  did: string;

  @ApiProperty({ description: 'did:algo network slug derived from GENESIS_ID.' })
  network: string;

  @ApiProperty({ description: 'App id of the DIDAlgoStorage contract that hosts the document.' })
  appId: string;

  @ApiProperty({ description: 'W3C DID document.', type: Object })
  document: object;

  @ApiProperty({
    description: 'Confirmed transaction ids from the most recent publish flow.',
    type: [String],
  })
  txIds: string[];

  @ApiProperty({ description: 'When the record was last updated.', type: String, format: 'date-time' })
  updatedAt: Date;
}
