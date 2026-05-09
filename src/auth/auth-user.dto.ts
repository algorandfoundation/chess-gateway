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

  @ApiProperty({
    description:
      'Vault transit-key name bound to this user, or `null` when no vault key has been provisioned yet.',
    nullable: true,
    type: String,
  })
  vaultUserId!: string | null;

  @ApiPropertyOptional({
    description: 'Algorand address derived from the vault transit key.',
  })
  publicAddress?: string | null;

  @ApiPropertyOptional({
    description:
      'True once the user has completed a device + manifest attestation linking the better-auth account to the vault key.',
  })
  isVerified?: boolean;
  @ApiPropertyOptional({
    description: 'ISO timestamp the better-auth user record was created.',
    nullable: true,
    type: String,
  })
  createdAt?: string | null;
  @ApiPropertyOptional({
    description: 'ISO timestamp the better-auth user record was last updated.',
    nullable: true,
    type: String,
  })
  updatedAt?: string | null;
}

/**
 * Enriched view of a Better-Auth user: the same fields as
 * `AuthUserResponseDto` plus their current `LinkVerification` and
 * (if seeded) device manifest / DID document. Used by the manager
 * UI to display "everything we know" about a single user.
 */
export class AuthUserDetailDto extends AuthUserResponseDto {
  @ApiPropertyOptional({
    description:
      'Wallet address recorded on the link-verification row (set by the link attestation flow).',
  })
  walletAddress?: string | null;

  @ApiPropertyOptional({
    description: 'When the better-auth ↔ vault mapping was last written.',
  })
  associatedAt?: string | null;

  @ApiPropertyOptional({
    description: 'Current did:key for this user, when a device manifest has been seeded.',
  })
  didKey?: string | null;

  @ApiPropertyOptional({
    description: 'Current revision number of the seeded device manifest.',
  })
  manifestVersion?: number | null;

  @ApiPropertyOptional({
    description: 'Full DID Document of the current device manifest revision.',
    type: 'object',
    additionalProperties: true,
  })
  didDocument?: Record<string, unknown> | null;
}
