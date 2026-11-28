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

const WINDOWS_FORBIDDEN_CHARS_RE = /[<>:"|?*]/;
const WINDOWS_RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const MAX_SEGMENT_UTF8_BYTES = 255;

export interface EntryValidationResult {
  readonly ok: boolean;
  readonly normalizedRelative?: string;
  readonly resolvedTarget?: string;
  readonly topLevelSegment?: string;
  readonly error?: string;
}

export interface EntryCreationResult {
  readonly targetPath: string;
  readonly focusName: string;
}

function validateSegmentCrossPlatform(segment: string, platform: NodeJS.Platform): string | null {
  if (!segment || segment === '.' || segment === '..') {
    return 'Operação bloqueada: segmentos "." e ".." não são permitidos.';
  }
  if (CONTROL_CHARS_RE.test(segment)) {
    return 'Nome inválido: contém caracteres de controle não permitidos.';
  }
  if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_UTF8_BYTES) {
    return `Nome inválido: segmento excede o limite de ${MAX_SEGMENT_UTF8_BYTES} bytes UTF-8.`;
  }
  if (platform === 'win32') {
    if (WINDOWS_FORBIDDEN_CHARS_RE.test(segment)) {
      return 'Nome inválido no Windows: caracteres < > : " | ? * não são permitidos.';
    }
    if (segment.endsWith(' ') || segment.endsWith('.')) {
      return 'Nome inválido no Windows: não pode terminar com ponto ou espaço.';
    }
    if (WINDOWS_RESERVED_NAME_RE.test(segment)) {
      return `Nome reservado do Windows ("${segment}") não pode ser usado.`;
    }
  }
  return null;
}

export function validateEntryPathCrossPlatform(
  baseDir: string,
  rawInput: string,
  platform: NodeJS.Platform = process.platform,
  options: { allowTrailingSlash?: boolean } = {}
): EntryValidationResult {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { ok: false, error: 'Informe um nome válido.' };
  }
  if (CONTROL_CHARS_RE.test(trimmed)) {
    return { ok: false, error: 'Nome inválido: contém caracteres de controle não permitidos.' };
  }

  const startsWithRoot =
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    /^[a-zA-Z]:/.test(trimmed) ||
    path.isAbsolute(trimmed) ||
    path.posix.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed);
  if (startsWithRoot) {
    return { ok: false, error: 'Nome inválido (use apenas caminho relativo seguro dentro da pasta atual).' };
  }

  const hasTrailingSep = trimmed.endsWith('/') || trimmed.endsWith('\\');
  if (hasTrailingSep && !options.allowTrailingSlash) {
    return { ok: false, error: 'Nome de arquivo não pode terminar com separador de pasta.' };
  }

  const withoutTrailing = hasTrailingSep ? trimmed.replace(/[/\\]+$/, '') : trimmed;
  if (!withoutTrailing) {
    return { ok: false, error: 'Informe um nome válido.' };
  }

  const segments = withoutTrailing.split(/[/\\]+/);
  for (const seg of segments) {
    const segErr = validateSegmentCrossPlatform(seg, platform);
    if (segErr) return { ok: false, error: segErr };
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, ...segments);
  const basePrefix = resolvedBase.endsWith(path.sep) ? resolvedBase : `${resolvedBase}${path.sep}`;
  if (resolvedTarget === resolvedBase || !resolvedTarget.startsWith(basePrefix)) {
    return { ok: false, error: 'Operação bloqueada: caminho fora do diretório ativo.' };
  }

  return {
    ok: true,
    normalizedRelative: segments.join(path.sep),
    resolvedTarget,
    topLevelSegment: segments[0],
  };
}

function formatFsCreationError(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EEXIST' || code === 'ERR_FS_CP_EEXIST') {
    return new Error('Já existe um arquivo ou pasta com esse nome.');
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}

export async function createFileSafe(
  baseDir: string,
  rawRelativePath: string,
  platform: NodeJS.Platform = process.platform
): Promise<EntryCreationResult> {
  const validation = validateEntryPathCrossPlatform(baseDir, rawRelativePath, platform, {
    allowTrailingSlash: false,
  });
  if (!validation.ok || !validation.resolvedTarget || !validation.topLevelSegment) {
    throw new Error(validation.error ?? 'Nome de arquivo inválido.');
  }

  try {
    await fs.mkdir(path.dirname(validation.resolvedTarget), { recursive: true });
    await fs.writeFile(validation.resolvedTarget, '', { flag: 'wx' });
    return { targetPath: validation.resolvedTarget, focusName: validation.topLevelSegment };
  } catch (err) {
    throw formatFsCreationError(err);
  }
}

export async function createFolderSafe(
  baseDir: string,
  rawRelativePath: string,
  platform: NodeJS.Platform = process.platform
): Promise<EntryCreationResult> {
  const validation = validateEntryPathCrossPlatform(baseDir, rawRelativePath, platform, {
    allowTrailingSlash: true,
  });
  if (!validation.ok || !validation.resolvedTarget || !validation.topLevelSegment) {
    throw new Error(validation.error ?? 'Nome de pasta inválido.');
  }

  try {
    await fs.stat(validation.resolvedTarget);
    throw new Error('Já existe um arquivo ou pasta com esse nome.');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') throw formatFsCreationError(err);
  }

  try {
    await fs.mkdir(validation.resolvedTarget, { recursive: true });
    return { targetPath: validation.resolvedTarget, focusName: validation.topLevelSegment };
  } catch (err) {
    throw formatFsCreationError(err);
  }
}

export function suggestDuplicateName(
  existingNames: ReadonlySet<string>,
  originalName: string,
  isDirectory: boolean
): string {
  const lastDot = isDirectory ? -1 : originalName.lastIndexOf('.');
  const hasExt = lastDot > 0;
  const base = hasExt ? originalName.slice(0, lastDot) : originalName;
  const ext = hasExt ? originalName.slice(lastDot) : '';

  const firstCandidate = `${base}-copy${ext}`;
  if (!existingNames.has(firstCandidate)) return firstCandidate;

  for (let idx = 2; idx < 10_000; idx++) {
    const candidate = `${base}-copy-${idx}${ext}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${base}-copy-${Date.now()}${ext}`;
}

export async function duplicateEntrySafe(
  sourcePath: string,
  newRelativeName: string,
  platform: NodeJS.Platform = process.platform
): Promise<EntryCreationResult> {
  const resolvedSource = path.resolve(sourcePath);
  const parentDir = path.dirname(resolvedSource);
  const validation = validateEntryPathCrossPlatform(parentDir, newRelativeName, platform, {
    allowTrailingSlash: false,
  });
  if (!validation.ok || !validation.resolvedTarget || !validation.topLevelSegment) {
    throw new Error(validation.error ?? 'Nome de destino inválido para duplicação.');
  }

  const target = validation.resolvedTarget;
  const sourcePrefix = resolvedSource.endsWith(path.sep) ? resolvedSource : `${resolvedSource}${path.sep}`;
  if (target === resolvedSource || target.startsWith(sourcePrefix)) {
    throw new Error('Operação bloqueada: não é possível duplicar um item sobre si mesmo.');
  }

  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(resolvedSource, target, { recursive: true, force: false, errorOnExist: true });
    return { targetPath: target, focusName: validation.topLevelSegment };
  } catch (err) {
    throw formatFsCreationError(err);
  }
}

export async function createFileOrDir(baseDir: string, rawName: string): Promise<string> {
  const trimmed = rawName.trim();
  if (trimmed.endsWith('/') || trimmed.endsWith('\\')) {
    const res = await createFolderSafe(baseDir, trimmed);
    return res.targetPath;
  }
  const res = await createFileSafe(baseDir, trimmed);
  return res.targetPath;
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

export async function safeWriteTextFile(filePath: string, content: string): Promise<{ bytes: number }> {
  const resolved = path.resolve(filePath);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_PREVIEW_BYTES) {
    throw new Error('Arquivo excede o limite seguro de 2 MB para salvamento no editor embutido.');
  }
  await fs.writeFile(resolved, content, 'utf8');
  return { bytes };
}
