/**
 * Multi-Language Terminal Syntax Highlighter (SPEC-001)
 * Tokenizador rápido e leve sem dependências externas com números de linha
 * e conformidade total com os 3 temas oficiais do Exploreio.
 */

import path from 'node:path';
import { fg, type ThemePalette } from '../themes/palette.js';
import { BOLD, DIM, ITALIC, RESET, stripUnsafeAnsi } from '../tui/ansi.js';

export type CodeLanguage =
  | 'ts'
  | 'js'
  | 'py'
  | 'rust'
  | 'go'
  | 'c'
  | 'css'
  | 'html'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'sql'
  | 'sh'
  | 'md'
  | 'plain';

const EXT_TO_LANG: Readonly<Record<string, CodeLanguage>> = {
  '.ts': 'ts',
  '.tsx': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.js': 'js',
  '.jsx': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.py': 'py',
  '.pyi': 'py',
  '.rs': 'rust',
  '.go': 'go',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'c',
  '.hpp': 'c',
  '.cc': 'c',
  '.java': 'c',
  '.cs': 'c',
  '.kt': 'c',
  '.swift': 'c',
  '.css': 'css',
  '.scss': 'css',
  '.less': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.xhtml': 'html',
  '.xml': 'html',
  '.svg': 'html',
  '.json': 'json',
  '.jsonc': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.ini': 'toml',
  '.env': 'sh',
  '.sql': 'sql',
  '.sh': 'sh',
  '.bash': 'sh',
  '.zsh': 'sh',
  '.ps1': 'sh',
  '.bat': 'sh',
  '.cmd': 'sh',
  '.md': 'md',
  '.mdx': 'md',
};

const KEYWORDS_BY_LANG: Readonly<Record<string, ReadonlySet<string>>> = {
  js: new Set([
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for',
    'from', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of',
    'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
    'undefined', 'var', 'void', 'while', 'with', 'yield',
  ]),
  ts: new Set([
    'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
    'continue', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
    'false', 'finally', 'for', 'from', 'function', 'if', 'implements', 'import', 'in',
    'infer', 'instanceof', 'interface', 'is', 'keyof', 'let', 'module', 'namespace', 'new',
    'null', 'of', 'override', 'private', 'protected', 'public', 'readonly', 'return',
    'satisfies', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type',
    'typeof', 'undefined', 'var', 'void', 'while', 'yield',
  ]),
  py: new Set([
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
    'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import',
    'in', 'is', 'lambda', 'match', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise',
    'return', 'True', 'try', 'while', 'with', 'yield',
  ]),
  rust: new Set([
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
    'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod',
    'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super',
    'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while',
  ]),
  go: new Set([
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
    'false', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'nil',
    'package', 'range', 'return', 'select', 'struct', 'switch', 'true', 'type', 'var',
  ]),
  c: new Set([
    'auto', 'bool', 'break', 'case', 'catch', 'char', 'class', 'const', 'continue',
    'default', 'do', 'double', 'else', 'enum', 'explicit', 'export', 'extern', 'false',
    'final', 'float', 'for', 'if', 'implements', 'import', 'inline', 'int', 'interface',
    'long', 'namespace', 'new', 'null', 'nullptr', 'override', 'package', 'private',
    'protected', 'public', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
    'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef', 'typename', 'union',
    'unsigned', 'using', 'virtual', 'void', 'volatile', 'while',
  ]),
  sql: new Set([
    'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
    'CREATE', 'TABLE', 'ALTER', 'DROP', 'INDEX', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER',
    'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'ORDER', 'BY', 'GROUP', 'HAVING',
    'LIMIT', 'OFFSET', 'DISTINCT', 'UNION', 'ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'BEGIN', 'COMMIT', 'ROLLBACK',
  ]),
  sh: new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until',
    'case', 'esac', 'function', 'return', 'local', 'export', 'readonly', 'unset', 'echo',
    'printf', 'exit', 'true', 'false', 'param', 'foreach', 'try', 'catch', 'finally',
  ]),
};

export function detectLanguageFromPath(filePath: string): CodeLanguage {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'sh';
  if (base === 'makefile') return 'sh';
  const ext = path.extname(base);
  return EXT_TO_LANG[ext] ?? 'plain';
}

export function normalizeLangAlias(raw?: string): CodeLanguage {
  const clean = (raw ?? '').trim().toLowerCase();
  if (!clean) return 'plain';
  const aliases: Readonly<Record<string, CodeLanguage>> = {
    ts: 'ts', typescript: 'ts', tsx: 'ts',
    js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    py: 'py', python: 'py',
    rs: 'rust', rust: 'rust',
    go: 'go', golang: 'go',
    c: 'c', cpp: 'c', 'c++': 'c', java: 'c', cs: 'c', csharp: 'c', kt: 'c',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', htm: 'html', xml: 'html', svg: 'html',
    json: 'json', jsonc: 'json',
    yaml: 'yaml', yml: 'yaml',
    toml: 'toml', ini: 'toml',
    sql: 'sql',
    sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', pwsh: 'sh', powershell: 'sh', ps1: 'sh',
    md: 'md', markdown: 'md',
  };
  return aliases[clean] ?? 'plain';
}

function highlightHtmlLine(line: string, theme: ThemePalette): string {
  // Comentário HTML
  if (line.includes('<!--')) {
    return line.replace(/(<!--[\s\S]*?-->)/g, `${fg(theme.syntaxComment)}${ITALIC}$1${RESET}`);
  }
  return line.replace(
    /(<\/?)([a-zA-Z0-9:-]+)([^>]*?)(\/?>)/g,
    (_m, open: string, tag: string, attrs: string, close: string) => {
      const styledAttrs = attrs.replace(
        /([a-zA-Z0-9_:-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/g,
        `${fg(theme.syntaxAttr)}$1${RESET}${fg(theme.syntaxOperator)}$2${RESET}${fg(theme.syntaxString)}$3${RESET}`
      );
      return `${fg(theme.muted)}${open}${RESET}${fg(theme.syntaxTag)}${BOLD}${tag}${RESET}${styledAttrs}${fg(theme.muted)}${close}${RESET}`;
    }
  );
}

function highlightYamlOrTomlLine(line: string, theme: ThemePalette): string {
  const commentIdx = line.indexOf('#');
  const head = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
  const comment = commentIdx >= 0 ? `${fg(theme.syntaxComment)}${ITALIC}${line.slice(commentIdx)}${RESET}` : '';

  if (/^\s*\[[^\]]+\]\s*$/.test(head)) {
    return `${fg(theme.accent)}${BOLD}${head}${RESET}${comment}`;
  }
  const kv = head.match(/^(\s*-?\s*)([A-Za-z0-9_.-]+)(\s*[:=]\s*)(.*)$/);
  if (!kv) return `${fg(theme.text)}${head}${RESET}${comment}`;

  const [, indent = '', key = '', sep = '', val = ''] = kv;
  let styledVal = `${fg(theme.syntaxString)}${val}${RESET}`;
  if (/^(true|false|null|~)$/i.test(val.trim())) {
    styledVal = `${fg(theme.syntaxKeyword)}${BOLD}${val}${RESET}`;
  } else if (/^-?\d+(\.\d+)?$/.test(val.trim())) {
    styledVal = `${fg(theme.syntaxNumber)}${val}${RESET}`;
  }
  return `${fg(theme.muted)}${indent}${RESET}${fg(theme.syntaxAttr)}${key}${RESET}${fg(theme.syntaxOperator)}${sep}${RESET}${styledVal}${comment}`;
}

function highlightCssLine(line: string, theme: ThemePalette): string {
  if (/^\s*\/\*/.test(line) || /^\s*\*/.test(line)) {
    return `${fg(theme.syntaxComment)}${ITALIC}${line}${RESET}`;
  }
  const prop = line.match(/^(\s*)([a-zA-Z-]+)(\s*:\s*)(.+?)(;?)$/);
  if (prop) {
    const [, indent = '', name = '', colon = '', val = '', semi = ''] = prop;
    const styledVal = val
      .replace(/(#[0-9a-fA-F]{3,8}\b)/g, `${fg(theme.syntaxNumber)}$1${RESET}`)
      .replace(/(\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|ms|s)?\b)/g, `${fg(theme.syntaxNumber)}$1${RESET}`);
    return `${indent}${fg(theme.syntaxAttr)}${name}${RESET}${fg(theme.syntaxOperator)}${colon}${RESET}${fg(theme.syntaxString)}${styledVal}${RESET}${fg(theme.muted)}${semi}${RESET}`;
  }
  return `${fg(theme.syntaxTag)}${line}${RESET}`;
}

function highlightGenericLine(line: string, lang: CodeLanguage, theme: ThemePalette): string {
  const kwSet = KEYWORDS_BY_LANG[lang] ?? KEYWORDS_BY_LANG.ts;
  const isHashComment = lang === 'py' || lang === 'sh';
  const isSqlComment = lang === 'sql';

  let out = '';
  let i = 0;

  while (i < line.length) {
    const ch = line[i] ?? '';
    const next = line[i + 1] ?? '';

    // Comentários de linha
    if (
      (!isHashComment && !isSqlComment && ch === '/' && next === '/') ||
      (isHashComment && ch === '#') ||
      (isSqlComment && ch === '-' && next === '-')
    ) {
      out += `${fg(theme.syntaxComment)}${ITALIC}${line.slice(i)}${RESET}`;
      break;
    }

    // Bloco /* ... */ inline
    if (ch === '/' && next === '*') {
      const end = line.indexOf('*/', i + 2);
      const slice = end >= 0 ? line.slice(i, end + 2) : line.slice(i);
      out += `${fg(theme.syntaxComment)}${ITALIC}${slice}${RESET}`;
      i += slice.length;
      continue;
    }

    // Strings
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      const str = line.slice(i, j);
      // Em JSON, strings seguidas por `:` são chaves
      const after = line.slice(j).trimStart();
      const color = lang === 'json' && after.startsWith(':') ? theme.syntaxAttr : theme.syntaxString;
      out += `${fg(color)}${str}${RESET}`;
      i = j;
      continue;
    }

    // Números
    if (/[0-9]/.test(ch) && (i === 0 || !/[A-Za-z0-9_$]/.test(line[i - 1] ?? ''))) {
      let j = i;
      while (j < line.length && /[0-9a-fA-FxXoObB_.]/.test(line[j] ?? '')) j++;
      out += `${fg(theme.syntaxNumber)}${line.slice(i, j)}${RESET}`;
      i = j;
      continue;
    }

    // Identificadores / palavras-chave / tipos / chamadas de função
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j] ?? '')) j++;
      const word = line.slice(i, j);
      const checkWord = lang === 'sql' ? word.toUpperCase() : word;

      if (kwSet?.has(checkWord)) {
        out += `${fg(theme.syntaxKeyword)}${BOLD}${word}${RESET}`;
      } else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) {
        out += `${fg(theme.syntaxType)}${word}${RESET}`;
      } else if (line[j] === '(') {
        out += `${fg(theme.syntaxFunction)}${word}${RESET}`;
      } else {
        out += `${fg(theme.text)}${word}${RESET}`;
      }
      i = j;
      continue;
    }

    // Operadores e pontuação
    if (/[=<>!+\-*/%&|^~?:{}()[\].,;]/.test(ch)) {
      out += `${fg(theme.syntaxOperator)}${ch}${RESET}`;
      i++;
      continue;
    }

    out += `${fg(theme.text)}${ch}${RESET}`;
    i++;
  }

  return out;
}

export function highlightCodeLine(rawLine: string, lang: CodeLanguage, theme: ThemePalette): string {
  const safe = stripUnsafeAnsi(rawLine);
  if (!safe) return '';
  if (lang === 'html') return highlightHtmlLine(safe, theme);
  if (lang === 'yaml' || lang === 'toml') return highlightYamlOrTomlLine(safe, theme);
  if (lang === 'css') return highlightCssLine(safe, theme);
  if (lang === 'plain' || lang === 'md') return `${fg(theme.text)}${safe}${RESET}`;
  return highlightGenericLine(safe, lang, theme);
}

export interface CodeRenderOptions {
  readonly language: CodeLanguage;
  readonly theme: ThemePalette;
  readonly showLineNumbers?: boolean;
  readonly maxLines?: number;
}

export function renderCodeLines(content: string, options: CodeRenderOptions): string[] {
  const { language, theme, showLineNumbers = true, maxLines } = options;
  const rawLines = content.replace(/\r\n/g, '\n').split('\n');
  const limit = maxLines ? Math.min(rawLines.length, maxLines) : rawLines.length;
  const gutterWidth = Math.max(3, String(rawLines.length).length);
  const out: string[] = [];

  for (let i = 0; i < limit; i++) {
    const highlighted = highlightCodeLine(rawLines[i] ?? '', language, theme);
    if (showLineNumbers) {
      const num = String(i + 1).padStart(gutterWidth, ' ');
      out.push(`${fg(theme.muted)}${DIM}${num} │${RESET} ${highlighted}`);
    } else {
      out.push(highlighted);
    }
  }

  if (limit < rawLines.length) {
    out.push(
      `${fg(theme.warning)}${ITALIC}… (+${rawLines.length - limit} linhas — pressione Enter para abrir o leitor completo)${RESET}`
    );
  }
  return out;
}
