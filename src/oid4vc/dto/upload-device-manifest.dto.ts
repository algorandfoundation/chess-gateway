import { IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Matches, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body of `POST /v1/oid4vc/devices/manifest`.
 *
 * The wallet sends the *full* DID Document plus a signature over the
 * canonicalised payload `{ didKey, version, signedAt, didDocument }`.
 *
 * See `src/oid4vc/DISCOVERY.md` — "Wire format".
 */
export class UploadDeviceManifestDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/, {
    message: 'didKey must be a valid did:key:z… identifier',
  })
  @ApiProperty({
    example: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
    description: 'The wallet primary did:key identifier (multibase Ed25519).',
  })
  didKey: string;

  @IsInt()
  @Min(1)
  @ApiProperty({
    example: 7,
    description: 'Wallet-assigned monotonic version. Must strictly increase per did:key.',
  })
  version: number;

  @IsString()
  @IsNotEmpty()
  @ApiProperty({
    example: '2026-05-06T18:30:00.000Z',
    description: 'Wallet-supplied wall-clock timestamp at signing time (ISO 8601).',
  })
  signedAt: string;

  @IsObject()
  @ApiProperty({
    description:
      'Full W3C DID Document the wallet has just persisted locally. Must contain a primary Ed25519VerificationKey2020 whose multibase key derives the supplied didKey.',
  })
  didDocument: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  @ApiProperty({
    description:
      'Base64 (standard) Ed25519 signature over JCS({ didKey, version, signedAt, didDocument }).',
  })
  signature: string;
}

/**
 * Payload for the `LinkResponseDto.deviceManifest` seed (link-attestation
 * is the only path that may *create* a manifest row for a previously
 * unseen did:key). Same shape as the standalone upload.
 */
export class LinkSeedDeviceManifestDto extends UploadDeviceManifestDto {
  @IsOptional()
  @ApiProperty({
    required: false,
    description: 'Optional — wallets without OID4VC support may omit this field.',
  })
  // marker subclass; kept distinct in case future seed-only fields are needed
  declare didKey: string;
}

/**
 * Response of `POST /v1/oid4vc/devices/manifest` and the `GET` endpoint.
 */
export class DeviceManifestResponseDto {
  @ApiProperty()
  manifestId: string;

  @ApiProperty()
  didKey: string;

  @ApiProperty()
  userId: string;

  @ApiProperty()
  version: number;

  @ApiProperty()
  revisionId: string;

  @ApiProperty({ required: false, nullable: true })
  revokedAt?: string | null;
}
