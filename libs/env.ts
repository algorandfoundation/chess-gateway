import * as fs from 'fs';
import * as path from 'path';

/**
 * Update (or insert) `key=value` in the project's `.env` file at
 * the workspace root. Used by **bootstrap scripts only** (Vault
 * AppRole creation in `vault/development-init.ts`, ad-hoc operator
 * tooling, etc.) — the running service does **not** write to `.env`.
 *
 * Operational state that used to live here (notably the
 * `DIDAlgoStorage` app id) now lives in Vault KV-v2 under
 * `secret/intermezzo/...`. Prefer `VaultService.kvWrite` for anything
 * new.
 */
export function updateEnvFile(key: string, value: string): void {
  const envPath = path.resolve(process.cwd(), '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    // file may not exist yet; start fresh
  }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    if (content.length > 0 && !content.endsWith('\n')) content += '\n';
    content += line + '\n';
  }
  fs.writeFileSync(envPath, content);
}
