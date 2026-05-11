import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/**
 * Response shape for the backfill endpoint that provisions a per-user
 * AppRole for a pre-existing ("legacy") user whose Vault transit key was
 * created before the per-user-AppRole feature shipped.
 *
 * `secret_id` is returned exactly once — Vault will not disclose it again —
 * so the manager calling this endpoint is responsible for delivering it to
 * the end user out-of-band.
 */
export class UserAppRoleResponseDto {
  @IsString()
  @ApiProperty({
    example: '1234',
    description: 'The unique identifier of the User the AppRole was provisioned for.',
  })
  user_id: string;

  @IsString()
  @ApiProperty({
    example: '1234',
    description: 'AppRole `role_id` for the per-user role. Pinned to `user_id`.',
  })
  role_id: string;

  @IsString()
  @ApiProperty({
    example: 'b6a23f3e-7b1f-4c84-9c8a-2a3d3a5e9f10',
    description:
      'Freshly-minted AppRole `secret_id`. Returned exactly once; the caller is responsible for ' +
      'delivering it to the user out-of-band.',
  })
  secret_id: string;
}
