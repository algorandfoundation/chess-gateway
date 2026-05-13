import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Request,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthUserService } from './auth-user.service';
import { Public } from './constants';
import { SignInRequestDto, SignInResponseDto } from './sign-in.dto';
import {
  AuthUserDetailDto,
  AuthUserResponseDto,
  CreateAuthUserDto,
  UpdateAuthUserDto,
} from './auth-user.dto';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

@Controller()
export class Auth {
  constructor(
    private readonly authService: AuthService,
    private readonly authUserService: AuthUserService,
  ) {}

  /**
   * Exchange a Vault service `vault_token` for a gateway-issued JWT.
   * Intended for machine / service-account callers that already hold
   * a Vault token (e.g. from an AppRole login). Human users should
   * authenticate via Better-Auth (OTP / SSO / passkeys) and use the
   * resulting session cookie instead.
   */
  @Public()
  @Post('auth/token')
  @ApiOperation({
    summary: 'Issue access token',
    description:
      'Exchanges a Vault `vault_token` for a gateway JWT. Use this for service / machine accounts; human users sign in via Better-Auth sessions.',
  })
  @ApiCreatedResponse({
    description: 'The access token has been successfully created.',
    type: SignInResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async token(@Body() signInParams: SignInRequestDto): Promise<SignInResponseDto> {
    return this.authService.signIn(signInParams.vault_token);
  }

  /**
   * @deprecated Use `POST /auth/token` instead. Kept for backwards
   * compatibility with existing service clients and will be removed
   * in a future release.
   */
  @Public()
  @Post('auth/sign-in/')
  @ApiOperation({
    summary: 'Sign In (deprecated)',
    description:
      'Deprecated — use `POST /auth/token` instead. Exchanges a `vault_token` for a gateway JWT.',
    deprecated: true,
  })
  @ApiCreatedResponse({
    description: 'The access token has been successfully created.',
    type: SignInResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async signIn(@Body() signInParams: SignInRequestDto): Promise<SignInResponseDto> {
    return this.authService.signIn(signInParams.vault_token);
  }

  /**
   * Provision a new Intermezzo Better-Auth user end-to-end:
   * Better-Auth row + vault transit key + link verification mapping.
   *
   * Authenticated by the regular JWT — the embedded `vault_token`
   * must be the manager-scoped one (issued via `signInWithRole` on
   * the manager AppRole) because we use it to mint the transit key.
   */
  @ApiBearerAuth()
  @Post('auth/user')
  @ApiOperation({
    summary: 'Create Intermezzo user',
    description:
      'Creates a Better-Auth user, provisions their vault wallet, and writes the link-verification document used by future device-link flows.',
  })
  @ApiCreatedResponse({ type: AuthUserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async createUser(
    @Request() request: any,
    @Body() body: CreateAuthUserDto,
  ): Promise<AuthUserResponseDto> {
    return this.authUserService.createUser(body, request.vault_token);
  }

  /**
   * Update an existing Intermezzo Better-Auth user. Supports
   * email/name edits, role changes (incl. promoting to `manager`),
   * and re-binding to a different vault transit key.
   */
  @ApiBearerAuth()
  @Put('auth/user/:userId')
  @ApiOperation({
    summary: 'Update Intermezzo user',
    description:
      'Update Better-Auth profile fields, role, and/or the vault transit key the user is bound to.',
  })
  @ApiOkResponse({ type: AuthUserResponseDto })
  @ApiNotFoundResponse({ description: 'User not found' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async updateUser(
    @Request() request: any,
    @Param('userId') userId: string,
    @Body() body: UpdateAuthUserDto,
  ): Promise<AuthUserResponseDto> {
    return this.authUserService.updateUser(userId, body, request.vault_token);
  }

  /**
   * Returns every Better-Auth user with the data the manager UI
   * needs to render them: email, name, role, verification state and
   * (when available) the Algorand `public_address` derived from the
   * vault transit key. Authenticated by the regular JWT — the
   * embedded `vault_token` is used to fetch the vault key list.
   */
  @ApiBearerAuth()
  @Get('auth/users')
  @ApiOperation({
    summary: 'List Intermezzo users',
    description:
      'Returns every Better-Auth user enriched with the link verification mapping (vault user id, isVerified) and the Algorand public address from the vault transit key.',
  })
  @ApiOkResponse({ type: AuthUserDetailDto, isArray: true })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async listUsers(@Request() request: any): Promise<AuthUserDetailDto[]> {
    return this.authUserService.listUsers(request.vault_token);
  }

  /**
   * Returns the enriched detail view for a single Better-Auth user.
   */
  @ApiBearerAuth()
  @Get('auth/user/:userId')
  @ApiOperation({
    summary: 'Get an Intermezzo user',
    description:
      'Returns one Better-Auth user enriched with vault binding, public address and verification status. The current device manifest / DID Document is exposed by `GET /oid4vc/admin/manifest/:userId`.',
  })
  @ApiOkResponse({ type: AuthUserDetailDto })
  @ApiNotFoundResponse({ description: 'User not found' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async getUser(
    @Request() request: any,
    @Param('userId') userId: string,
  ): Promise<AuthUserDetailDto> {
    return this.authUserService.getUser(userId, request.vault_token);
  }

  /**
   * Deletes a Better-Auth user and their `LinkVerification` mapping.
   * The vault transit key is preserved so it can be re-bound to a
   * freshly provisioned user via `POST /auth/user`.
   */
  @ApiBearerAuth()
  @Delete('auth/user/:userId')
  @ApiOperation({
    summary: 'Delete Intermezzo user',
    description:
      'Removes a Better-Auth user (and any sessions/accounts/verification rows). The underlying vault transit key is intentionally retained.',
  })
  @ApiOkResponse({
    description: 'The user has been deleted.',
    schema: {
      example: { userId: 'b1cFxqd5QarPFxyEzeJQhkz1RhfExEol', deleted: true },
    },
  })
  @ApiNotFoundResponse({ description: 'User not found' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async deleteUser(
    @Param('userId') userId: string,
  ): Promise<{ userId: string; deleted: true }> {
    return this.authUserService.deleteUser(userId);
  }
}
