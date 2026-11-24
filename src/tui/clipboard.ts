/**
 * Cross-Platform Safe Clipboard Utility (SPEC-001)
 * Copia texto (ex.: caminho completo de arquivo/pasta) para a área de transferência
 * usando stdin sem shell (proteção contra command injection) e fallback OSC 52.
 */

import { spawn } from 'node:child_process';

export interface ClipboardCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly label: string;
}

export interface ClipboardResult {
  readonly ok: boolean;
  readonly method?: string;
  readonly error?: string;
}

export type ClipboardRunner = (cmd: ClipboardCommand, text: string, timeoutMs: number) => Promise<void>;

export interface CopyClipboardOptions {
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
  readonly allowOsc52Fallback?: boolean;
  readonly writeOsc52?: (sequence: string) => void;
  readonly runner?: ClipboardRunner;
}

const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Retorna a lista ordenada de comandos nativos de clipboard para a plataforma informada.
 * Todos consomem o conteúdo exclusivamente via stdin (sem interpolação em argumentos).
 */
export function getClipboardCommands(platform: NodeJS.Platform = process.platform): readonly ClipboardCommand[] {
  if (platform === 'win32') {
    return [
      {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())',
        ],
        label: 'powershell-clipboard',
      },
      {
        command: 'clip.exe',
        args: [],
        label: 'clip',
      },
    ];
  }

  if (platform === 'darwin') {
    return [{ command: 'pbcopy', args: [], label: 'pbcopy' }];
  }

  return [
    { command: 'wl-copy', args: [], label: 'wl-copy' },
    { command: 'xclip', args: ['-selection', 'clipboard'], label: 'xclip' },
    { command: 'xsel', args: ['--clipboard', '--input'], label: 'xsel' },
  ];
}

/** Gera a sequência ANSI OSC 52 segura em Base64 para fallback em terminais remotos/SSH. */
export function formatOsc52Sequence(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  return `\x1b]52;c;${encoded}\x07`;
}

function runClipboardCommand(cmd: ClipboardCommand, text: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd.command, [...cmd.args], {
      stdio: ['pipe', 'ignore', 'ignore'],
      shell: false,
      windowsHide: true,
    });

    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Timeout ao executar ${cmd.command}`));
    }, timeoutMs);

    child.once('error', (err) => finish(err));
    child.once('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`${cmd.command} encerrou com código ${code ?? 'desconhecido'}`));
    });

    child.stdin.once('error', (err) => finish(err));
    child.stdin.end(text, 'utf8');
  });
}

/**
 * Copia `text` para o clipboard do sistema operacional com degradação segura.
 */
export async function copyTextToClipboard(
  text: string,
  options: CopyClipboardOptions = {}
): Promise<ClipboardResult> {
  if (!text) {
    return { ok: false, error: 'Nenhum caminho disponível para copiar.' };
  }

  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = options.runner ?? runClipboardCommand;
  const commands = getClipboardCommands(platform);

  let lastError = 'Nenhum utilitário de clipboard disponível';
  for (const cmd of commands) {
    try {
      await runner(cmd, text, timeoutMs);
      return { ok: true, method: cmd.label };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  const allowOsc52 = options.allowOsc52Fallback ?? Boolean(process.stdout.isTTY);
  if (allowOsc52) {
    const writer = options.writeOsc52 ?? ((seq: string) => {
      process.stdout.write(seq);
    });
    writer(formatOsc52Sequence(text));
    return { ok: true, method: 'osc52' };
  }

  return { ok: false, error: lastError };
}
