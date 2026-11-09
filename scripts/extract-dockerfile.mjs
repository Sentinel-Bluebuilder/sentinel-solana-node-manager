// Extract the inlined Dockerfile from src/main/services/docker.ts and
// write it to ./build-ctx/Dockerfile so we can `docker build --load`
// manually while upstream fixes the BuildKit tagging bug.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(repoRoot, 'src/main/services/docker.ts'), 'utf8');

const match = src.match(/export const SENTINEL_DVPNX_DOCKERFILE = `([\s\S]*?)`;/);
if (!match) throw new Error('could not find SENTINEL_DVPNX_DOCKERFILE in docker.ts');

const dockerfile = match[1]
  .replace(/\\\$\{/g, '${')
  .replace(/\\`/g, '`')
  .replace(/\\\\/g, '\\');

const outDir = resolve(repoRoot, 'build-ctx');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'Dockerfile'), dockerfile, 'utf8');
console.log(`wrote ${resolve(outDir, 'Dockerfile')} (${dockerfile.length} bytes)`);
