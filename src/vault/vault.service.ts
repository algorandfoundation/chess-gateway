import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosResponse } from 'axios';
import { HttpErrorByCode } from '@nestjs/common/utils/http-error-by-code.util';
import { UserInfoDto } from './user-info.dto';

export type KeyType = 'ed25519' | 'ecdsa-p256';
export type HashAlgorithm = 'sha2-256' | 'sha2-512';

// Prefix for per-user AppRoles provisioned via createUserAppRole. Must match
// the `auth/approle/role/pawn_user_*` paths granted by `pawn_managers_policy`
// in `vault/development-init.ts`, and the role naming consumed by the templated
// `pawn_users_scoped_policy`.
export const PER_USER_APP_ROLE_PREFIX = 'pawn_user_';
export const USERS_SCOPED_POLICY_NAME = 'pawn_users_scoped_policy';

// Vault AppRole role names allow alphanumerics plus `-`, `_`, `.`. Any other
// character would either be rejected by Vault or, worse, silently break the
// 1:1 mapping between role name and user id. Validate explicitly.
const APPROLE_NAME_SAFE_RE = /^[A-Za-z0-9._-]+$/;

export type UserAppRoleCredentials = {
  role_id: string;
  secret_id: string;
};

@Injectable()
export class VaultService {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  /**
   *
   * @param token - personal access token
   * @returns
   */
  async authGithub(token: string): Promise<string> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const vaultNamespace: string = this.configService.get<string>('VAULT_NAMESPACE');

    let result: AxiosResponse;
    try {
      result = await this.httpService.axiosRef.post(
        `${baseUrl}/v1/auth/github/login`,
        {
          token: token,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(vaultNamespace ? { 'X-Vault-Namespace': vaultNamespace } : {}),
          },
        },
      );

      // log with stringify
      Logger.log('Github login result: ', JSON.stringify(result.data));
    } catch (error) {
      Logger.error('Failed to login with Personal Access Token', JSON.stringify(error));
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }
    const vault_token: string = result.data.auth.client_token;
    return vault_token;
  }

  async transitCreateKey(keyName: string, transitKeyPath: string, token: string): Promise<Buffer> {
    // https://developer.hashicorp.com/vault/api-docs/secret/transit#create-key
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');

    let result: AxiosResponse;

    const url: string = `${baseUrl}/v1/${transitKeyPath}/keys/${keyName}`;
    try {
      result = await this.httpService.axiosRef.post(
        url,
        {
          type: 'ed25519',
          derived: false,
          allow_deletion: false,
        },
        {
          headers: { 'X-Vault-Token': token },
        },
      );
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }

    const publicKeyBase64: string = result.data.data.keys['1'].public_key;
    return Buffer.from(publicKeyBase64, 'base64');
  }

  /**
   * Implicitly uses a (GET) HTTP request to retrieve the public key of a user from the vault.
   *
   * @param keyName - user id
   * @param transitKeyPath - path to the transit engine
   * @param token - vault token
   * @returns - public key of the user
   */
  async getKey(keyName: string, transitKeyPath: string, token: string): Promise<Buffer> {
    // https://developer.hashicorp.com/vault/api-docs/secret/transit#read-key
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const vaultNamespace: string = this.configService.get<string>('VAULT_NAMESPACE');

    let result: AxiosResponse;
    try {
      const url = `${baseUrl}/v1/${transitKeyPath}/keys/${keyName}`;
      Logger.log('getKey url: ', url);

      result = await this.httpService.axiosRef.get(url, {
        headers: {
          'X-Vault-Token': token,
          'Content-Type': 'application/json',
          ...(vaultNamespace ? { 'X-Vault-Namespace': vaultNamespace } : {}),
        },
      });
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }

    const publicKeyBase64: string = result.data.data.keys['1'].public_key;
    return Buffer.from(publicKeyBase64, 'base64');
  }

  public async sign(keyName: string, transitPath: string, data: Uint8Array, token: string): Promise<Buffer> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const vaultNamespace: string = this.configService.get<string>('VAULT_NAMESPACE');

    let result: AxiosResponse;
    try {
      result = await this.httpService.axiosRef.post(
        `${baseUrl}/v1/${transitPath}/sign/${keyName}`,
        {
          input: Buffer.from(data).toString('base64'),
        },
        {
          headers: {
            'X-Vault-Token': token,
            ...(vaultNamespace ? { 'X-Vault-Namespace': vaultNamespace } : {}),
          },
        },
      );
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }

    return result.data.data.signature;
  }

  /**
   *
   * @param roleId - Role ID of the AppRole
   * @param secretId - Secret ID of the AppRole
   * @returns - client token based on the AppRole
   * @throws - VaultException
   * @description - This method is used to authenticate with the Vault using AppRole authentication.
   * The AppRole authentication method is used to authenticate machines or applications that need to access the Vault.
   * The method takes the Role ID and Secret ID of the AppRole and returns a client token that can be used to access the Vault.
   * The client token is valid for a certain period of time and can be used to access the Vault until it expires.
   * The method uses the AppRole authentication endpoint of the Vault API to authenticate and retrieve the client token.
   * The method throws a VaultException if the authentication fails or if there is an error while communicating with the Vault.
   */
  async getTokenWithRole(roleId: string, secretId: string): Promise<string> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');

    let result: AxiosResponse;
    try {
      result = await this.httpService.axiosRef.post(`${baseUrl}/v1/auth/approle/login`, {
        role_id: roleId,
        secret_id: secretId,
      });
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }
    const token: string = result.data.auth.client_token;
    return token;
  }

  async checkToken(token: string): Promise<boolean> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');

    try {
      await this.httpService.axiosRef.get(`${baseUrl}/v1/auth/token/lookup-self`, {
        headers: { 'X-Vault-Token': token },
      });
      return true;
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }
  }

  async signAsUser(user_id: string, data: Uint8Array, token: string): Promise<Buffer> {
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');

    return this.sign(user_id, transitKeyPath, data, token);
  }

  async signAsManager(data: Uint8Array, token: string): Promise<Buffer> {
    const manager_id = this.configService.get('VAULT_MANAGER_KEY');
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_MANAGERS_PATH');

    return this.sign(manager_id, transitKeyPath, data, token);
  }

  async getUserPublicKey(keyName: string, token: string): Promise<Buffer> {
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');

    return this.getKey(keyName, transitKeyPath, token);
  }

  async getManagerPublicKey(token: string): Promise<Buffer> {
    const manager_id = this.configService.get('VAULT_MANAGER_KEY');
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_MANAGERS_PATH');

    return this.getKey(manager_id, transitKeyPath, token);
  }

  /**
   * Provision a per-user AppRole scoped to a single transit key via the
   * templated `pawn_users_scoped_policy`. The returned credentials let the
   * end user authenticate to Vault with a token whose ACL is restricted to
   * their own `pawn/users/keys/<user_id>` and `pawn/users/sign/<user_id>`
   * paths — and nothing else.
   *
   * Two important details:
   *  - The role name is `pawn_user_<user_id>`; the `pawn_user_*` prefix is
   *    what `pawn_managers_policy` grants management of, so this call
   *    requires a manager Vault token.
   *  - We pin the role's `role_id` to the raw `user_id`. Vault uses
   *    `role_id` as the AppRole token's entity-alias name, which is what
   *    the templated policy `{{identity.entity.aliases.<accessor>.name}}`
   *    resolves to at request time. Keeping `role_id == user_id` is what
   *    makes the per-identity scoping actually work.
   *
   * @param user_id  Gateway-level user id; becomes both the role-name suffix
   *                 and the pinned `role_id`. Must be `[A-Za-z0-9._-]+`.
   * @param token    A Vault token authorised by `pawn_managers_policy`.
   * @returns        `{ role_id, secret_id }` — caller is responsible for
   *                 delivering these to the user out-of-band.
   */
  async createUserAppRole(user_id: string, token: string): Promise<UserAppRoleCredentials> {
    if (!APPROLE_NAME_SAFE_RE.test(user_id)) {
      // Bad inputs would land on the request path verbatim and either be
      // rejected by Vault or — worse — broaden the role's scope by hitting
      // an unexpected endpoint. Fail closed.
      throw new HttpErrorByCode[400](
        `Invalid user_id for per-user AppRole; expected [A-Za-z0-9._-]+, got "${user_id}"`,
      );
    }

    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const roleName = `${PER_USER_APP_ROLE_PREFIX}${user_id}`;
    const headers = { 'X-Vault-Token': token };

    try {
      // 1. Create (or update) the role bound to the templated user policy.
      //    `bind_secret_id=true` is the AppRole default but we set it
      //    explicitly so future readers don't have to look it up.
      await this.httpService.axiosRef.post(
        `${baseUrl}/v1/auth/approle/role/${roleName}`,
        {
          token_policies: [USERS_SCOPED_POLICY_NAME],
          token_type: 'batch',
          bind_secret_id: true,
        },
        { headers },
      );

      // 2. Pin role_id to the user_id so the entity alias name == user_id.
      //    Without this, the templated policy would resolve to a random UUID
      //    and the user would have no usable scope.
      await this.httpService.axiosRef.post(
        `${baseUrl}/v1/auth/approle/role/${roleName}/role-id`,
        { role_id: user_id },
        { headers },
      );

      // 3. Mint a fresh secret_id to hand back to the caller.
      const secretIdResponse: AxiosResponse = await this.httpService.axiosRef.post(
        `${baseUrl}/v1/auth/approle/role/${roleName}/secret-id`,
        {},
        { headers },
      );

      return {
        role_id: user_id,
        secret_id: secretIdResponse.data.data.secret_id,
      };
    } catch (error) {
      Logger.error(`Failed to provision per-user AppRole '${roleName}'`, JSON.stringify(error?.response?.data));
      throw new HttpErrorByCode[error.response?.status ?? 500]('VaultException');
    }
  }

  /**
   * Expecting a manager token to retrieve all keys from the vault and return an array of user objects including
   * it's user id and public address.
   *
   * @param token - manager token
   * @returns
   */
  async getKeys(token: string): Promise<UserInfoDto[]> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');

    let result: AxiosResponse;

    try {
      // method LIST
      result = await this.httpService.axiosRef.request({
        url: `${baseUrl}/v1/${transitKeyPath}/keys`,
        method: 'LIST',
        headers: { 'X-Vault-Token': token },
      });
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }

    const users: string[] = result.data.data.keys;

    // for each add the public address to an array of user object (id, public address)
    const usersObjs: UserInfoDto[] = [];
    for (let i = 0; i < users.length; i++) {
      const userObj = {
        public_address: (await this.getKey(users[i], transitKeyPath, token)).toString('base64'), // TODO: rename public_address that is actually the public key in base64 format
        user_id: users[i],
      };
      usersObjs.push(userObj);
    }

    return usersObjs;
  }
}
