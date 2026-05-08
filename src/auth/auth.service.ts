import { Injectable } from '@nestjs/common';
import { VaultService } from '../vault/vault.service';
import { JwtService } from '@nestjs/jwt';
import { SignInResponseDto } from './sign-in.dto';
import { auth } from '../link/auth';
import { VerificationService } from '../link/verification/verification.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly vaultService: VaultService,
    private jwtService: JwtService,
    private readonly verificationService: VerificationService,
  ) {}

  /**
   * Sign in with a role ID and secret ID to get a vault token.
   * @param roleId The role ID for the Vault authentication.
   * @param secretId The secret ID for the Vault authentication.
   * @returns The vault token.
   */
  async signInWithRole(roleId: string, secretId: string): Promise<string> {
    const vault_token = await this.vaultService.getTokenWithRole(roleId, secretId);
    return vault_token;
  }

  /**
   * Sign in with a vault token to get a JWT token.
   * @param vault_token The vault token for authentication.
   * @returns The JWT token.
   */
  async signIn(vault_token: string): Promise<SignInResponseDto> {
    await this.vaultService.checkToken(vault_token);

    const payload = { vault_token: vault_token };
    const response = { access_token: await this.jwtService.signAsync(payload) };

    return response as SignInResponseDto;
  }

  async authGithub(token: string): Promise<string> {
    const vault_token = await this.vaultService.authGithub(token);
    return vault_token;
  }

  /**
   * Reverse-lookup the email of a vault user id. Walks the
   * `LinkVerification` rows (which carry the Better-Auth `userId`)
   * and resolves the email via the Better-Auth adapter. Returns
   * `null` when no mapping exists yet.
   */
  async getUserEmail(userId: string): Promise<string | null> {
    const matches = await this.verificationService.findByPlayerId(userId);
    if (!matches?.length) return null;
    const ctx: any = await (auth as any).$context;
    const adapter = ctx.adapter;
    const beUser = await adapter.findOne({
      model: 'user',
      where: [{ field: 'id', value: matches[0].userId }],
    });
    return beUser?.email ?? null;
  }

  /**
   * Resolve an email to its vault player id by going through
   * Better-Auth → `LinkVerification`. The mapping is created when a
   * manager calls `POST /auth/user` (or amends one via
   * `PUT /auth/user/:userId`), so unknown emails return `null` and
   * callers must instruct the manager to create the user first.
   */
  async getUserIdByEmail(email: string): Promise<string | null> {
    if (!email) return null;
    const ctx: any = await (auth as any).$context;
    const adapter = ctx.adapter;
    const beUser = await adapter.findOne({
      model: 'user',
      where: [{ field: 'email', value: email }],
    });
    if (!beUser?.id) return null;
    const verification = await this.verificationService.findByUserId(beUser.id);
    return verification?.id ?? null;
  }
}
