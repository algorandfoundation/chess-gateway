import { IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { UploadDeviceManifestDto } from '../oid4vc/dto/upload-device-manifest.dto';

export class LinkResponseDto {
  @IsString()
  @IsNotEmpty()
  @ApiProperty({ example: '0x123...', description: 'The wallet address to link' })
  walletAddress: string;

  @IsString()
  @IsOptional()
  @ApiProperty({ description: 'Google Play Integrity token (Android)', required: false })
  integrityToken?: string;

  @IsString()
  @IsOptional()
  @ApiProperty({ description: 'Apple App Attest attestation object (iOS)', required: false })
  attestationObject?: string;

  @IsString()
  @IsOptional()
  @ApiProperty({ description: 'Apple App Attest key identifier (iOS)', required: false })
  keyId?: string;

  /**
   * Optional signed wallet `did:key` device manifest. When the wallet
   * supplies it, the link-attestation flow is the *only* place that
   * may seed a manifest for a previously-unseen `did:key`. Subsequent
   * updates go through `POST /v1/oid4vc/devices/manifest`.
   *
   * See `src/oid4vc/DISCOVERY.md`.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => UploadDeviceManifestDto)
  @ApiProperty({
    description:
      "Optional signed wallet did:key device manifest to seed on first attestation. Wallets without OID4VC support may omit this field.",
    type: () => UploadDeviceManifestDto,
    required: false,
  })
  deviceManifest?: UploadDeviceManifestDto;
}

export class ChallengeResponseDto {
  @ApiProperty({ example: 'a-very-long-unique-challenge-string' })
  challenge: string;
}
