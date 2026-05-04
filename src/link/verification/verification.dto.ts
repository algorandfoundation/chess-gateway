import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateLinkVerificationDto {
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  id: string;

  @IsString()
  @IsOptional()
  @ApiProperty({ required: false })
  walletAddress?: string;

  @IsOptional()
  @ApiProperty({ required: false, default: false })
  isVerified?: boolean;
}

export class UpdateLinkVerificationDto {
  @IsString()
  @IsOptional()
  @ApiProperty({ required: false })
  userId?: string;

  @IsString()
  @IsOptional()
  @ApiProperty({ required: false })
  id?: string;

  @IsString()
  @IsOptional()
  @ApiProperty({ required: false })
  walletAddress?: string;

  @IsOptional()
  @ApiProperty({ required: false })
  isVerified?: boolean;
}
