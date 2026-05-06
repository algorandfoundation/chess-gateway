import * as fs from 'fs';
import * as path from 'path';

/**
 * Updates a key in the .env file if it exists, otherwise appends it.
 * Only works when running in a local/dev environment where the .env file is accessible.
 */
export function updateEnvFile(key: string, value: string): void {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    console.warn(`.env file not found at ${envPath}, skipping update.`);
    return;
  }

  try {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const lines = envContent.split(/\r?\n/);
    let keyFound = false;

    const newLines = lines.map((line) => {
      // Check for key=value pattern, ignoring comments and whitespace
      const match = line.match(/^\s*([^#=]+)\s*=\s*(.*)$/);
      if (match && match[1].trim() === key) {
        keyFound = true;
        return `${key}=${value}`;
      }
      return line;
    });

    if (!keyFound) {
      newLines.push(`${key}=${value}`);
    }

    fs.writeFileSync(envPath, newLines.join('\n'));
    console.log(`Successfully updated ${key} in .env`);
  } catch (err) {
    console.error(`Failed to update .env file: ${err}`);
  }
}
