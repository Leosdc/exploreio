#!/usr/bin/env node
/**
 * Exploreio Interactive Setup Wizard (SPEC-001)
 * Pergunta ao usuário se deseja ativar os comandos globais (`exploreio` e `exp`)
 * e escolher o tema padrão salvo em ~/.exploreiorc.json.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runNpm(args) {
  return spawnSync(npmBin, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('◈ Exploreio: terminal não interativo detectado. Para instalar comandos globais manualmente, execute: npm link');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  ◈ EXPLOREIO — Assistente de Configuração Inicial        ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // 1. Garante build pronto
    if (!fs.existsSync(path.join(rootDir, 'dist', 'cli.js'))) {
      console.log('Compilando Exploreio pela primeira vez...');
      const buildRes = runNpm(['run', 'build']);
      if (buildRes.status !== 0) {
        console.error('Falha ao compilar o projeto. Verifique os erros acima.');
        process.exitCode = 1;
        return;
      }
    }

    // 2. Pergunta sobre comandos globais
    const wantGlobal = (
      await rl.question('Deseja ativar os comandos globais `exploreio` e `exp` para usar de qualquer pasta? (S/n): ')
    ).trim().toLowerCase();

    if (wantGlobal === '' || wantGlobal === 's' || wantGlobal === 'sim' || wantGlobal === 'y' || wantGlobal === 'yes') {
      console.log('\nRegistrando comandos globais via `npm link`...');
      const linkRes = runNpm(['link']);
      if (linkRes.status === 0) {
        console.log('✔ Comandos globais `exploreio` e `exp` ativados com sucesso!');
      } else {
        console.warn('▲ Não foi possível rodar `npm link` automaticamente (tente com permissões adequadas ou `sudo npm link` no Linux/macOS).');
      }
    } else {
      console.log('• Comandos globais pulados. Você ainda pode rodar com `node dist/cli.js` ou ativar depois com `npm run setup`.');
    }

    // 3. Escolha de tema padrão
    console.log('\nEscolha o tema padrão do terminal:');
    console.log('  1) Midnight (escuro de alto contraste — padrão)');
    console.log('  2) Parchment Light (claro para terminais claros)');
    console.log('  3) Nord (ártico equilibrado)');
    const themeChoice = (await rl.question('Tema padrão [1/2/3] (Enter = 1): ')).trim();
    const themeMap = { '1': 'midnight', '2': 'parchment', '3': 'nord' };
    const chosenTheme = themeMap[themeChoice] ?? 'midnight';

    const rcPath = path.join(os.homedir(), '.exploreiorc.json');
    fs.writeFileSync(rcPath, `${JSON.stringify({ theme: chosenTheme }, null, 2)}\n`, 'utf8');
    console.log(`✔ Tema padrão salvo (${chosenTheme}) em ${rcPath}`);

    console.log('\n🚀 Tudo pronto! Agora digite `exploreio` (ou `exp`) em qualquer pasta do seu terminal.\n');
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error('Erro no setup do Exploreio:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
