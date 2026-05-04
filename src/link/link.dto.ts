import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

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
}

export class ChallengeResponseDto {
  @ApiProperty({ example: 'a-very-long-unique-challenge-string' })
  challenge: string;
}
