import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UserInfoResponseDto {
  @IsString()
  @ApiProperty({
    example: '1234',
    description: 'The unique identifier of the User',
  })
  user_id: string;

  @IsString()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
    description: 'The public address of the User',
  })
  public_address: string;

  @IsString()
  @ApiProperty({
    type: 'string',
    example: '1000000',
    description: 'The balance of Algorand held by the User in microAlgos',
  })
  algoBalance: string;

  // The next two fields are only populated by the user-creation endpoint and
  // hold the per-user AppRole credentials minted at that time. They are the
  // one-and-only chance for the caller (manager) to capture the `secret_id`
  // and hand it to the end user; Vault does not allow re-reading it later.
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    example: '1234',
    description:
      'AppRole `role_id` for the newly-provisioned per-user role. Pinned to `user_id`. ' +
      'Only present in responses returned by the user-creation endpoint.',
  })
  role_id?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    example: 'b6a23f3e-7b1f-4c84-9c8a-2a3d3a5e9f10',
    description:
      'Freshly-minted AppRole `secret_id` for the per-user role. Returned exactly once at user-creation ' +
      'time; the caller is responsible for delivering it to the user out-of-band.',
  })
  secret_id?: string;
}
