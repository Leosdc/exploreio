/**
 * Cross-Platform Safe Fullscreen Terminal Launcher (SPEC-005)
 * Abre o arquivo selecionado/ativo do Exploreio em uma nova janela de terminal
 * em modo tela cheia (ideal quando o Exploreio está rodando em painel splitado),
 * usando `shell: false` e passagem segura de argumentos (anti-command-injection).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViewMode } from '../renderers/index.js';
import type { ThemeName } from '../themes/palette.js';

export interface LaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly label: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface FullscreenLaunchResult {
  readonly ok: boolean;
  readonly method?: string;
  readonly error?: string;
}

export type LaunchRunner = (cmd: LaunchCommand, timeoutMs: number) => Promise<void>;

export interface FullscreenLaunchOptions {
  readonly themeName?: ThemeName;
  readonly viewMode?: ViewMode;
  readonly platform?: NodeJS.Platform;
  readonly nodeExecPath?: string;
  readonly cliScriptPath?: string;
  readonly timeoutMs?: number;
  readonly runner?: LaunchRunner;
}

const DEFAULT_TIMEOUT_MS = 2500;

function resolveDefaultCliScriptPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
}

function escapeWtArg(arg: string): string {
  // Windows Terminal (`wt.exe`) usa `;` como separador de subcomandos
  return arg.replace(/;/g, '\\;');
}

/**
 * Monta a lista ordenada de comandos seguros para abrir o Exploreio em um novo
 * terminal fullscreen/maximizado na plataforma informada.
 */
export function getFullscreenLaunchCommands(
  targetFilePath: string,
  options: FullscreenLaunchOptions = {}
): readonly LaunchCommand[] {
  const platform = options.platform ?? process.platform;
  const nodeBin = options.nodeExecPath ?? process.execPath;
  const cliScript = options.cliScriptPath ?? resolveDefaultCliScriptPath();
  const resolvedFile = path.resolve(targetFilePath);
  const fileDir = path.dirname(resolvedFile);
  const fileName = path.basename(resolvedFile);

  const exploreioArgs: string[] = [cliScript, resolvedFile, '--single'];
  if (options.themeName) {
    exploreioArgs.push('--theme', options.themeName);
  }
  if (options.viewMode) {
    exploreioArgs.push('--mode', options.viewMode);
  }

  if (platform === 'win32') {
    const wtArgs = [
      '-w',
      'new',
      '-F',
      '-d',
      escapeWtArg(fileDir),
      '--title',
      escapeWtArg(`Exploreio — ${fileName}`),
      '--',
      escapeWtArg(nodeBin),
      ...exploreioArgs.map(escapeWtArg),
    ];

    return [
      {
        command: 'wt.exe',
        args: wtArgs,
        label: 'windows-terminal',
      },
      {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Start-Process -FilePath $env:EXPLOREIO_LAUNCH_BIN -ArgumentList ($env:EXPLOREIO_LAUNCH_ARGS_JSON | ConvertFrom-Json) -WorkingDirectory $env:EXPLOREIO_LAUNCH_CWD -WindowStyle Maximized',
        ],
        label: 'powershell-maximized',
        env: {
          EXPLOREIO_LAUNCH_BIN: nodeBin,
          EXPLOREIO_LAUNCH_ARGS_JSON: JSON.stringify(exploreioArgs),
          EXPLOREIO_LAUNCH_CWD: fileDir,
        },
      },
    ];
  }

  if (platform === 'darwin') {
    const appleScript = [
      'on run argv',
      '  set cmd to ""',
      '  repeat with a in argv',
      '    if cmd is not "" then set cmd to cmd & " "',
      '    set cmd to cmd & quoted form of (a as text)',
      '  end repeat',
      '  tell application "Terminal"',
      '    activate',
      '    do script cmd',
      '  end tell',
      'end run',
    ].join('\n');

    return [
      {
        command: 'osascript',
        args: ['-e', appleScript, '--', nodeBin, ...exploreioArgs],
        label: 'macos-terminal',
      },
    ];
  }

  return [
    {
      command: 'gnome-terminal',
      args: ['--full-screen', `--working-directory=${fileDir}`, '--', nodeBin, ...exploreioArgs],
      label: 'gnome-terminal',
    },
    {
      command: 'konsole',
      args: ['--fullscreen', '--workdir', fileDir, '-e', nodeBin, ...exploreioArgs],
      label: 'konsole',
    },
    {
      command: 'kitty',
      args: ['--start-as=fullscreen', '--directory', fileDir, nodeBin, ...exploreioArgs],
      label: 'kitty',
    },
    {
      command: 'alacritty',
      args: ['--working-directory', fileDir, '-o', 'window.startup_mode="Fullscreen"', '-e', nodeBin, ...exploreioArgs],
      label: 'alacritty',
    },
    {
      command: 'wezterm',
      args: ['start', '--cwd', fileDir, '--', nodeBin, ...exploreioArgs],
      label: 'wezterm',
    },
    {
      command: 'x-terminal-emulator',
      args: ['-e', nodeBin, ...exploreioArgs],
      label: 'x-terminal-emulator',
    },
  ];
}

function runDetachedLauncher(cmd: LaunchCommand, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd.command, [...cmd.args], {
      stdio: 'ignore',
      shell: false,
      detached: true,
      windowsHide: false,
      env: cmd.env ? { ...process.env, ...cmd.env } : process.env,
    });

    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    // Se o processo disparou sem erro imediato e permanece aberto (ex.: terminais Linux),
    // desvincula e considera lançado com sucesso.
    const timer = setTimeout(() => {
      child.unref();
      finish();
    }, Math.min(timeoutMs, 350));

    child.once('error', (err) => finish(err));
    child.once('exit', (code) => {
      if (code === 0 || code === null) {
        finish();
      } else {
        finish(new Error(`${cmd.command} encerrou com código ${code}`));
      }
    });
  });
}

/**
 * Abre `targetFilePath` em uma nova janela de terminal em tela cheia com degradação segura.
 */
export async function openInFullscreenShell(
  targetFilePath: string,
  options: FullscreenLaunchOptions = {}
): Promise<FullscreenLaunchResult> {
  if (!targetFilePath) {
    return { ok: false, error: 'Nenhum arquivo selecionado para abrir em tela cheia.' };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = options.runner ?? runDetachedLauncher;
  const commands = getFullscreenLaunchCommands(targetFilePath, options);

  let lastError = 'Nenhum emulador de terminal suportado encontrado';
  for (const cmd of commands) {
    try {
      await runner(cmd, timeoutMs);
      return { ok: true, method: cmd.label };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return { ok: false, error: lastError };
}
