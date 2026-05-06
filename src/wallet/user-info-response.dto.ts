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

  /**
   * Fully-qualified `did:algo` identifier published for this user, or
   * `null` when no DID has been published yet (e.g. legacy accounts).
   */
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    example: 'did:algo:localnet:app:1234:abcd...',
    description: 'Fully-qualified did:algo identifier for the user, or null if none.',
  })
  did?: string | null;

  /**
   * Wallet address provided during the link flow. `null` when the Vault
   * player has not yet been associated with an authenticated account
   * that supplied a local wallet address.
   */
  @IsOptional()
  @IsString()
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Associated local wallet address, or null if the user has not linked one.',
  })
  wallet_address: string | null;
}
