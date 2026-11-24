/**
 * Safe Filesystem Explorer & Preview Loader (SPEC-001)
 * Navegação de diretórios, ordenação, filtro fuzzy, detecção de binários,
 * limite seguro contra OOM e operações básicas com fail-safe.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024; // 2 MB cap para renderização rica

export interface FileEntry {
  readonly name: string;
  readonly fullPath: string;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
  readonly isHidden: boolean;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ext: string;
}

export interface DirectoryListing {
  readonly dirPath: string;
  readonly entries: FileEntry[];
  readonly error?: string;
}

export interface SafeFilePreview {
  readonly filePath: string;
  readonly size: number;
  readonly isBinary: boolean;
  readonly truncated: boolean;
  readonly magicLabel: string;
  readonly text: string;
  readonly rawHead: Uint8Array;
  readonly error?: string;
}

export interface DirectoryReadOptions {
  readonly showHidden?: boolean;
  readonly filter?: string;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[idx]}`;
}

export function fuzzyMatch(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const lower = text.toLowerCase();
  if (lower.includes(q)) return true;

  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

export async function readDirectoryEntries(
  dirPath: string,
  options: DirectoryReadOptions = {}
): Promise<DirectoryListing> {
  const resolved = path.resolve(dirPath);
  const showHidden = Boolean(options.showHidden);
  const filter = options.filter ?? '';

  try {
    const dirents = await fs.readdir(resolved, { withFileTypes: true });
    const entries: FileEntry[] = [];

    for (const dirent of dirents) {
      const isHidden = dirent.name.startsWith('.');
      if (!showHidden && isHidden) continue;
      if (filter && !fuzzyMatch(dirent.name, filter)) continue;

      const fullPath = path.join(resolved, dirent.name);
      let isDirectory = dirent.isDirectory();
      const isSymlink = dirent.isSymbolicLink();
      let size = 0;
      let mtimeMs = 0;

      try {
        const stat = await fs.stat(fullPath);
        isDirectory = stat.isDirectory();
        size = stat.size;
        mtimeMs = stat.mtimeMs;
      } catch {
        // Symlink quebrado ou sem permissão: preserva entrada sem quebrar listagem
      }

      entries.push({
        name: dirent.name,
        fullPath,
        isDirectory,
        isSymlink,
        isHidden,
        size,
        mtimeMs,
        ext: isDirectory ? '' : path.extname(dirent.name).toLowerCase(),
      });
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    return { dirPath: resolved, entries };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { dirPath: resolved, entries: [], error: `Não foi possível ler o diretório: ${msg}` };
  }
}

export function detectMagicSignature(buf: Uint8Array): string {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'PNG Image';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'JPEG Image';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'GIF Image';
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'PDF Document';
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'ZIP / Archive';
    if (buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d) return 'WebAssembly Binary';
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return 'ELF Executable';
    if (buf[0] === 0x4d && buf[1] === 0x5a) return 'Windows PE/EXE';
  }
  return 'Binary Data';
}

export function isBufferBinary(buf: Uint8Array): boolean {
  const sampleLen = Math.min(buf.length, 4096);
  let nonText = 0;
  for (let i = 0; i < sampleLen; i++) {
    const byte = buf[i] ?? 0;
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32 && byte !== 27)) nonText++;
  }
  return sampleLen > 0 && nonText / sampleLen > 0.25;
}

export async function safeReadFilePreview(
  filePath: string,
  maxBytes = MAX_PREVIEW_BYTES
): Promise<SafeFilePreview> {
  const resolved = path.resolve(filePath);
  let handle: fs.FileHandle | null = null;
  try {
    const stat = await fs.stat(resolved);
    const readLen = Math.min(stat.size, maxBytes);
    const buffer = Buffer.allocUnsafe(readLen);

    if (readLen > 0) {
      handle = await fs.open(resolved, 'r');
      await handle.read(buffer, 0, readLen, 0);
    }

    const binary = isBufferBinary(buffer);
    const rawHead = buffer.subarray(0, Math.min(buffer.length, 512));

    return {
      filePath: resolved,
      size: stat.size,
      isBinary: binary,
      truncated: stat.size > maxBytes,
      magicLabel: binary ? detectMagicSignature(rawHead) : 'UTF-8 Text',
      text: binary ? '' : buffer.toString('utf8'),
      rawHead,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      filePath: resolved,
      size: 0,
      isBinary: false,
      truncated: false,
      magicLabel: 'Error',
      text: '',
      rawHead: new Uint8Array(),
      error: `Erro ao ler arquivo: ${msg}`,
    };
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

export async function createFileOrDir(baseDir: string, rawName: string): Promise<string> {
  const trimmed = rawName.trim();
  if (!trimmed || trimmed.includes('..') || path.isAbsolute(trimmed)) {
    throw new Error('Nome inválido (use apenas caminho relativo seguro dentro da pasta atual).');
  }
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, trimmed);
  if (target !== resolvedBase && !target.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error('Operação bloqueada: caminho fora do diretório ativo.');
  }
  if (trimmed.endsWith('/') || trimmed.endsWith('\\')) {
    await fs.mkdir(target, { recursive: true });
  } else {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '', { flag: 'wx' });
  }
  return target;
}

export async function renameEntry(entryPath: string, newName: string): Promise<string> {
  const trimmed = newName.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    throw new Error('Novo nome inválido.');
  }
  const target = path.join(path.dirname(path.resolve(entryPath)), trimmed);
  await fs.rename(path.resolve(entryPath), target);
  return target;
}

export async function deleteEntry(entryPath: string): Promise<void> {
  const resolved = path.resolve(entryPath);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    throw new Error('Operação bloqueada: não é permitido remover a raiz do sistema.');
  }
  await fs.rm(resolved, { recursive: true, force: false });
}
