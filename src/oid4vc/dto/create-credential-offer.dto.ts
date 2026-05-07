import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class CreateCredentialOfferDto {
  @ApiProperty({
    description:
      'Credential configuration ids that the wallet should be offered. Must match ids declared by the issuer ' +
      '(e.g. `credential-sd-jwt`).',
    example: ['credential-sd-jwt'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  credentialConfigurationIds!: string[];

  @ApiProperty({
    description:
      'Application user the offer is created for. Required: every credential is bound to the recipient\'s ' +
      'on-chain `did:algo`, so the issuer must know which platform user owns the offer.',
  })
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @ApiPropertyOptional({
    description:
      'Arbitrary metadata persisted with the issuance session. Typically the actual claim values that should be ' +
      'embedded in the credential when the wallet redeems the offer.',
    example: { rewardTier: 'gold', earnedAt: '2025-05-06T16:00:00.000Z' },
  })
  @IsOptional()
  @IsObject()
  issuanceMetadata?: Record<string, unknown>;
}

export class CreateSelfOfferDto {
  @ApiPropertyOptional({
    description:
      'Credential configuration ids the wallet should be offered. Defaults to `credential-sd-jwt` when omitted.',
    example: ['credential-sd-jwt'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  credentialConfigurationIds?: string[];

  @ApiPropertyOptional({
    description: 'Optional metadata stored with the issuance session and embedded into the credential.',
    example: { rewardTier: 'gold' },
  })
  @IsOptional()
  @IsObject()
  issuanceMetadata?: Record<string, unknown>;
}

export class CredentialOfferResponseDto {
  @ApiProperty({ description: 'Local (TypeORM) issuance session id used by this service.' })
  id!: string;

  @ApiProperty({ description: 'Id of the underlying Credo OpenId4VcIssuanceSessionRecord.' })
  credoIssuanceSessionId!: string;

  @ApiProperty({
    description: 'Credential offer URI (`openid-credential-offer://...`). Render this as a QR code for the wallet.',
  })
  credentialOffer!: string;

  @ApiProperty({ description: 'Current state of the Credo issuance session.' })
  state!: string;

  @ApiPropertyOptional({
    description:
      'Full `did:algo` identifier the holder must bind their proof JWT to (i.e. the credential ' +
      'will be issued for `<holderDid>#keys-2`). Returned by demo/self-offer so the wallet does ' +
      'not need to resolve the platform user → DID mapping itself.',
    example:
      'did:algo:localnet:app:1002:00b475231a2a0fef585ead1e69c1b7341c78da2fa6f040d44879f732055bf4bd',
  })
  holderDid?: string;
}

export class HolderDidResponseDto {
  @ApiProperty({
    description: 'Vault/player id (the same id that keys the on-chain DID document).',
    example: 'bob',
  })
  playerId!: string;

  @ApiProperty({
    description: 'Full `did:algo` identifier of the authenticated user.',
    example:
      'did:algo:localnet:app:1002:00b475231a2a0fef585ead1e69c1b7341c78da2fa6f040d44879f732055bf4bd',
  })
  did!: string;
}
