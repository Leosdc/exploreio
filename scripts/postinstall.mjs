/**
 * Exploreio Post-Install Hook (SPEC-001)
 * Orienta sobre comandos globais sem nunca travar instalações em CI ou sem TTY.
 * Quando executado em terminal interativo local (não global, não CI), oferece
 * iniciar o assistente de configuração (`scripts/setup.mjs`).
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isGlobal = process.env.npm_config_global === 'true';
const isCi = Boolean(process.env.CI || process.env.GITHUB_ACTIONS || process.env.CONTINUOUS_INTEGRATION);

if (isGlobal) {
  console.log('\n◈ Exploreio instalado globalmente! Digite `exploreio` ou `exp` em qualquer pasta.\n');
  process.exit(0);
}

if (!isCi && process.stdin.isTTY && process.stdout.isTTY) {
  const setupScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'setup.mjs');
  spawnSync(process.execPath, [setupScript], { stdio: 'inherit' });
} else {
  console.log(
    '\n◈ Exploreio instalado! Deseja ativar os comandos globais `exploreio` e `exp` e escolher seu tema padrão?\n' +
      '  Execute: npm run setup\n'
  );
}
