import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class SponsoredClaimAssetRequestDto {
  @Transform((val) => BigInt(val.value))
  @ApiProperty({
    example: 1234567890,
    description: 'The id of the Asset to claim',
  })
  assetId: bigint;

  @IsNumber()
  @Min(1)
  @ApiProperty({
    example: 10,
    description: 'The amount of the Asset to claim',
  })
  amount: number;

  @IsString()
  @IsOptional()
  @ApiProperty({
    example: '9kykoZ1IpuOAqhzDgRVaVY2ME0ZlCNrUpnzxpXlEF/s=',
    description:
      'Optional 32-byte base64-encoded lease to prevent replay and conflicting transactions. Use a fixed value to ensure exclusivity.',
    required: false,
  })
  lease?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  @ApiProperty({
    example: 'Claiming asset to linked wallet',
    description: 'Optional public note to attach to transaction',
    required: false,
  })
  note?: string;
}

export class SponsoredClaimAssetResponseDto {
  @ApiProperty({
    example: 'QOOBRVQMX4HW5QZ2EGLQDQCQTKRF3UP3JKDGKYPCXMI6AVV35KQA',
    description: 'The transaction id of the grouped claim transaction',
  })
  transaction_id: string;
}
