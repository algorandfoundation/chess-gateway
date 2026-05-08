import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString } from 'class-validator';

/**
 * Allowed Better-Auth roles. Mirrors the `adminRoles` configured on
 * the admin plugin in `src/link/auth.ts`. `user` is the default role
 * for newly-created Intermezzo accounts; `manager` and `admin` are
 * privileged roles capable of impersonation.
 */
export const AUTH_USER_ROLES = ['user', 'manager', 'admin'] as const;
export type AuthUserRole = (typeof AUTH_USER_ROLES)[number];

export class CreateAuthUserDto {
  @ApiProperty({ example: 'alice@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Alice Player' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({
    enum: AUTH_USER_ROLES,
    default: 'user',
    description:
      'Better-Auth role. Defaults to `user`. Use `manager` for vault-managers that need impersonation rights.',
  })
  @IsOptional()
  @IsIn(AUTH_USER_ROLES as unknown as string[])
  role?: AuthUserRole;

  @ApiPropertyOptional({
    description:
      'Optional explicit vault transit-key name. Defaults to the sanitised local-part of the email.',
  })
  @IsOptional()
  @IsString()
  vaultUserId?: string;
}

export class UpdateAuthUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ enum: AUTH_USER_ROLES })
  @IsOptional()
  @IsIn(AUTH_USER_ROLES as unknown as string[])
  role?: AuthUserRole;

  @ApiPropertyOptional({
    description:
      'Re-bind the Better-Auth user to a different vault transit key. The vault key is created if it does not yet exist.',
  })
  @IsOptional()
  @IsString()
  vaultUserId?: string;
}

export class AuthUserResponseDto {
  @ApiProperty()
  userId!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: AUTH_USER_ROLES })
  role!: AuthUserRole;

  @ApiProperty({ description: 'Vault transit-key name bound to this user.' })
  vaultUserId!: string;

  @ApiPropertyOptional({
    description: 'Algorand address derived from the vault transit key.',
  })
  publicAddress?: string | null;
}
