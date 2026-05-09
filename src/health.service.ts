import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

export class HealthServiceProbeDto {
  @ApiProperty({ example: 'vault' })
  name: string;

  @ApiProperty({ example: true })
  ok: boolean;

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
  @ApiProperty({ example: 'ok', enum: ['ok', 'degraded'] })
  status: 'ok' | 'degraded';

  @ApiProperty({ example: '2026-05-08T19:14:55.713Z' })
  timestamp: string;

  @ApiProperty({ type: HealthServiceProbeDto, isArray: true })
  services: HealthServiceProbeDto[];
}

/**
 * Aggregate health/status probe used by the manager debug page and any
 * external monitor. Pings the gateway's external dependencies (Vault, the
 * Algorand node, and the local sqlite database that backs both TypeORM
 * and Better-Auth) and returns one row per probed service so callers can
 * tell at a glance which subsystem is degraded.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async check(): Promise<HealthResponseDto> {
    const services = await Promise.all([
      this.probeVault(),
      this.probeAlgod(),
      this.probeDatabase(),
    ]);

    const status: 'ok' | 'degraded' = services.every((s) => s.ok) ? 'ok' : 'degraded';
    return {
      status,
      timestamp: new Date().toISOString(),
      services,
    };
  }

  private async probeVault(): Promise<HealthServiceProbeDto> {
    const baseUrl = this.configService.get<string>('VAULT_BASE_URL') || '';
    const url = `${baseUrl}/v1/sys/health`;
    return this.timed('vault', url, async () => {
      // Vault returns non-200 status codes for sealed/standby states; we
      // accept any 200/4xx response as "reachable" and surface the body
      // for diagnostics, but only treat the standard 200/429 as healthy.
      const res = await this.httpService.axiosRef.get(url, {
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
    const scheme = this.configService.get<string>('NODE_HTTP_SCHEME') || '';
    const host = this.configService.get<string>('NODE_HOST') || '';
    const port = this.configService.get<string>('NODE_PORT') || '';
    const token = this.configService.get<string>('NODE_TOKEN') || '';
    const authority = port ? `${host}:${port}` : host;
    const url = `${scheme}://${authority}/versions`;
    return this.timed('algod', url, async () => {
      const res = await this.httpService.axiosRef.get(url, {
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

  private async probeDatabase(): Promise<HealthServiceProbeDto> {
    const opts = this.dataSource.options as { type?: string; database?: unknown };
    const url =
      opts.type === 'sqlite' && typeof opts.database === 'string'
        ? `sqlite://${opts.database}`
        : `typeorm://${opts.type ?? 'unknown'}`;
    return this.timed('database', url, async () => {
      // Cheapest possible round-trip; works on sqlite/postgres/mysql.
      await this.dataSource.query('SELECT 1');
      return { ok: this.dataSource.isInitialized, status: 200 };
    });
  }

  private async timed(
    name: string,
    url: string,
    run: () => Promise<Omit<HealthServiceProbeDto, 'name' | 'url' | 'latencyMs'>>,
  ): Promise<HealthServiceProbeDto> {
    const started = Date.now();
    try {
      const result = await run();
      return { name, url, latencyMs: Date.now() - started, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Health probe '${name}' failed: ${message}`);
      return {
        name,
        url,
        ok: false,
        status: null,
        latencyMs: Date.now() - started,
        error: message,
      };
    }
  }
}
