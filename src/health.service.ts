import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Per-service / per-config-block lifecycle state.
 *
 * - `uninitialized` — required env keys are missing (or the URL we'd hit
 *   isn't configured at all). The probe was skipped; nothing was contacted.
 * - `ok` — fully configured AND the live probe (if any) succeeded.
 * - `degraded` — fully configured but the live probe failed/returned a
 *   non-healthy status.
 */
export type HealthState = 'ok' | 'degraded' | 'uninitialized';

export class HealthConfigurationDto {
  @ApiProperty({ example: ['VAULT_BASE_URL', 'VAULT_ROLE_ID'] })
  requiredEnv: string[];

  @ApiProperty({ example: ['VAULT_ROLE_ID'] })
  missingEnv: string[];

  @ApiProperty({
    example: true,
    description: 'true when every entry in requiredEnv is set to a non-empty value',
  })
  configured: boolean;
}

export class HealthServiceProbeDto {
  @ApiProperty({ example: 'vault' })
  name: string;

  @ApiProperty({ example: 'ok', enum: ['ok', 'degraded', 'uninitialized'] })
  state: HealthState;

  @ApiProperty({
    example: true,
    description:
      'Convenience flag: `true` iff state === "ok". `false` for both degraded and uninitialized.',
  })
  ok: boolean;

  @ApiProperty({ type: HealthConfigurationDto })
  configuration: HealthConfigurationDto;

  @ApiProperty({ example: 'http://vault:8200/v1/sys/health', required: false })
  url?: string;

  @ApiProperty({ example: 200, nullable: true, required: false })
  status?: number | null;

  @ApiProperty({ example: 'OK', required: false })
  statusText?: string;

  @ApiProperty({ example: 12, required: false })
  latencyMs?: number;

  @ApiProperty({ example: 'connection refused', required: false })
  error?: string;

  @ApiProperty({
    example: { initialized: true, sealed: false },
    required: false,
    type: Object,
    additionalProperties: true,
  })
  details?: Record<string, unknown>;
}

export class HealthResponseDto {
  @ApiProperty({ example: 'ok', enum: ['ok', 'degraded', 'uninitialized'] })
  status: HealthState;

  @ApiProperty({ example: '2026-05-08T19:14:55.713Z' })
  timestamp: string;

  @ApiProperty({ type: HealthServiceProbeDto, isArray: true })
  services: HealthServiceProbeDto[];

  @ApiProperty({
    type: HealthConfigurationDto,
    description:
      'Top-level service-wide configuration block. Currently just the public BASE_URL the gateway advertises.',
  })
  baseURL: HealthConfigurationDto;
}

/**
 * Aggregate health/status probe used by the manager debug page and any
 * external monitor. Pings the gateway's external dependencies (Vault, the
 * Algorand node, and the local sqlite database that backs both TypeORM
 * and Better-Auth) and returns one row per probed service so callers can
 * tell at a glance which subsystem is degraded.
 *
 * Each per-service row also carries a `configuration` block listing the
 * env keys that subsystem requires and which (if any) of those are
 * unset. When required env is missing the live probe is skipped and the
 * service is reported as `uninitialized` — that way operators standing
 * up a fresh deployment see exactly which env vars to populate next
 * instead of a misleading "connection refused" error.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  // Env-var contracts per subsystem. Kept centralised here so the
  // bootstrap UI / docs can be driven off the same source eventually.
  private static readonly VAULT_REQUIRED_ENV = [
    'VAULT_ROLE_ID',
    'VAULT_SECRET_ID',
    'VAULT_BASE_URL',
    'VAULT_MANAGER_KEY',
    'VAULT_TRANSIT_USERS_PATH',
    'VAULT_TRANSIT_MANAGERS_PATH',
    'USER_VAULT_ROLE_ID',
    'USER_VAULT_SECRET_ID',
    'OID4VC_VAULT_ROLE_ID',
    'OID4VC_VAULT_SECRET_ID',
  ];
  private static readonly NODE_REQUIRED_ENV = [
    'GENESIS_ID',
    'GENESIS_HASH',
    'NODE_HTTP_SCHEME',
    'NODE_HOST',
    'NODE_PORT',
    'NODE_TOKEN',
  ];
  private static readonly AUTH_REQUIRED_ENV = ['SESSION_AUTH_SECRET', 'JWT_SECRET'];
  // Google social SSO is optional — the gateway boots fine without it
  // (OTP / passkeys still work). We surface its configuration on the
  // probe details so the bootstrap UI can show "Google: not configured"
  // without flipping the whole subsystem to `uninitialized`.
  private static readonly AUTH_OPTIONAL_GOOGLE_ENV = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
  ];
  private static readonly BASE_URL_REQUIRED_ENV = ['BASE_URL'];

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async check(): Promise<HealthResponseDto> {
    const baseURL = this.checkConfiguration(HealthService.BASE_URL_REQUIRED_ENV);

    const services = await Promise.all([
      this.probeVault(),
      this.probeAlgod(),
      this.probeAuth(),
      this.probeDatabase(),
    ]);

    const status: HealthState = this.aggregate([
      ...services.map((s) => s.state),
      // The top-level baseURL config block participates in the aggregate:
      // if BASE_URL is unset the whole gateway is considered uninitialized.
      baseURL.configured ? 'ok' : 'uninitialized',
    ]);

    return {
      status,
      timestamp: new Date().toISOString(),
      services,
      baseURL,
    };
  }

  /**
   * Reduce a list of per-service states into a single overall state.
   *
   *  - any `uninitialized` → `uninitialized` (operator hasn't finished setup)
   *  - else any `degraded` → `degraded`
   *  - else `ok`
   */
  private aggregate(states: HealthState[]): HealthState {
    if (states.some((s) => s === 'uninitialized')) return 'uninitialized';
    if (states.some((s) => s === 'degraded')) return 'degraded';
    return 'ok';
  }

  private getEnv(key: string): string {
    const raw = this.configService.get<string>(key);
    return typeof raw === 'string' ? raw.trim() : '';
  }

  /** Build a `HealthConfigurationDto` for a list of required env keys. */
  private checkConfiguration(requiredEnv: string[]): HealthConfigurationDto {
    const missingEnv = requiredEnv.filter((key) => this.getEnv(key) === '');
    return {
      requiredEnv,
      missingEnv,
      configured: missingEnv.length === 0,
    };
  }

  private async probeVault(): Promise<HealthServiceProbeDto> {
    const configuration = this.checkConfiguration(HealthService.VAULT_REQUIRED_ENV);
    const baseUrl = this.getEnv('VAULT_BASE_URL');
    const url = baseUrl ? `${baseUrl}/v1/sys/health` : undefined;

    if (!configuration.configured) {
      return this.uninitialized('vault', configuration, url);
    }

    return this.timed('vault', url, configuration, async () => {
      // Vault returns non-200 status codes for sealed/standby states; we
      // accept any 200/4xx response as "reachable" and surface the body
      // for diagnostics, but only treat the standard 200/429 as healthy.
      const res = await this.httpService.axiosRef.get(url as string, {
        validateStatus: () => true,
        timeout: 5000,
      });
      const body = res.data ?? {};
      const ok =
        res.status === 200 ||
        // 429 = unsealed standby (still reachable & functional from our perspective)
        res.status === 429;
      return {
        ok,
        status: res.status,
        statusText: res.statusText,
        details: {
          initialized: body.initialized,
          sealed: body.sealed,
          standby: body.standby,
          version: body.version,
        },
      };
    });
  }

  private async probeAlgod(): Promise<HealthServiceProbeDto> {
    const configuration = this.checkConfiguration(HealthService.NODE_REQUIRED_ENV);
    const scheme = this.getEnv('NODE_HTTP_SCHEME');
    const host = this.getEnv('NODE_HOST');
    const port = this.getEnv('NODE_PORT');
    const token = this.getEnv('NODE_TOKEN');
    const authority = port ? `${host}:${port}` : host;
    const url = scheme && host ? `${scheme}://${authority}/versions` : undefined;

    if (!configuration.configured) {
      return this.uninitialized('algod', configuration, url);
    }

    return this.timed('algod', url, configuration, async () => {
      const res = await this.httpService.axiosRef.get(url as string, {
        validateStatus: () => true,
        timeout: 5000,
        headers: token ? { 'X-Algo-API-Token': token } : undefined,
      });
      // algod /versions returns 200 with a JSON body describing the node
      // build, genesis, and supported API versions — strictly more useful
      // than /health (which is just an empty 200) for the debug page.
      const body = (res.data ?? {}) as {
        build?: {
          major?: number;
          minor?: number;
          build_number?: number;
          channel?: string;
          branch?: string;
          commit_hash?: string;
        };
        genesis_id?: string;
        genesis_hash_b64?: string;
        versions?: string[];
      };
      const build = body.build ?? {};
      const version =
        typeof build.major === 'number' && typeof build.minor === 'number'
          ? `${build.major}.${build.minor}.${build.build_number ?? 0}`
          : undefined;
      return {
        ok: res.status === 200,
        status: res.status,
        statusText: res.statusText,
        details: {
          host,
          port: port || null,
          scheme,
          tokenConfigured: Boolean(token),
          version,
          channel: build.channel,
          branch: build.branch,
          commitHash: build.commit_hash,
          genesisId: body.genesis_id,
          genesisHash: body.genesis_hash_b64,
          versions: body.versions,
        },
      };
    });
  }

  /**
   * Auth subsystem probe. Better-Auth itself runs in-process so there's
   * no remote endpoint to hit; the probe just verifies that every env key
   * the auth bootstrap requires is populated. Once `configured`, it's
   * `ok` — an actual auth failure surfaces via the request path, not
   * here.
   */
  private async probeAuth(): Promise<HealthServiceProbeDto> {
    const configuration = this.checkConfiguration(HealthService.AUTH_REQUIRED_ENV);
    const googleMissing = HealthService.AUTH_OPTIONAL_GOOGLE_ENV.filter(
      (key) => this.getEnv(key) === '',
    );
    const googleConfigured = googleMissing.length === 0;
    if (!configuration.configured) {
      return this.uninitialized('auth', configuration);
    }
    return {
      name: 'auth',
      state: 'ok',
      ok: true,
      configuration,
      details: {
        provider: 'better-auth',
        // Only advertise Google as a configured social provider when the
        // gateway actually has both env keys; otherwise the array is
        // empty and the UI knows to render Google as optional/disabled.
        socialProviders: googleConfigured ? ['google'] : [],
        optionalEnv: {
          google: {
            requiredEnv: HealthService.AUTH_OPTIONAL_GOOGLE_ENV,
            missingEnv: googleMissing,
            configured: googleConfigured,
          },
        },
      },
    };
  }

  private async probeDatabase(): Promise<HealthServiceProbeDto> {
    // The DB has no required env vars (sqlite path is derived in-process)
    // so the configuration block is empty-but-configured.
    const configuration = this.checkConfiguration([]);
    const opts = this.dataSource.options as { type?: string; database?: unknown };
    const url =
      opts.type === 'sqlite' && typeof opts.database === 'string'
        ? `sqlite://${opts.database}`
        : `typeorm://${opts.type ?? 'unknown'}`;
    return this.timed('database', url, configuration, async () => {
      // Cheapest possible round-trip; works on sqlite/postgres/mysql.
      await this.dataSource.query('SELECT 1');
      return { ok: this.dataSource.isInitialized, status: 200 };
    });
  }

  /** Build an `uninitialized` probe row (no live call attempted). */
  private uninitialized(
    name: string,
    configuration: HealthConfigurationDto,
    url?: string,
  ): HealthServiceProbeDto {
    return {
      name,
      state: 'uninitialized',
      ok: false,
      configuration,
      url,
      error: `Missing required env: ${configuration.missingEnv.join(', ')}`,
    };
  }

  private async timed(
    name: string,
    url: string | undefined,
    configuration: HealthConfigurationDto,
    run: () => Promise<{
      ok: boolean;
      status?: number | null;
      statusText?: string;
      details?: Record<string, unknown>;
    }>,
  ): Promise<HealthServiceProbeDto> {
    const started = Date.now();
    try {
      const result = await run();
      return {
        name,
        state: result.ok ? 'ok' : 'degraded',
        ok: result.ok,
        configuration,
        url,
        latencyMs: Date.now() - started,
        status: result.status,
        statusText: result.statusText,
        details: result.details,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Health probe '${name}' failed: ${message}`);
      return {
        name,
        state: 'degraded',
        ok: false,
        configuration,
        url,
        status: null,
        latencyMs: Date.now() - started,
        error: message,
      };
    }
  }
}
