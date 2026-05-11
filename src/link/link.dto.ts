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

export class OtpLookupResponseDto {
  @ApiProperty({ example: 'user@example.com', description: 'The email the OTP was issued for' })
  email: string;

  @ApiProperty({ example: 'sign-in', description: 'The OTP type (e.g. sign-in, email-verification, forget-password)' })
  type: string;

  @ApiProperty({ example: '123456', description: 'The plain OTP value stored by Better Auth' })
  otp: string;

  @ApiProperty({ example: 0, description: 'Number of verification attempts already consumed' })
  attempts: number;

  @ApiProperty({ example: '2026-01-01T00:00:00.000Z', description: 'OTP expiry timestamp (ISO 8601)' })
  expiresAt: string;
}
