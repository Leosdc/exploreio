/**
 * Exploreio Theme Palette (SPEC-001)
 * 3 temas oficiais de terminal (`midnight`, `parchment`, `nord`) com suporte
 * automático a Truecolor (24-bit) e fallback ANSI 256 cores.
 */

export type ThemeName = 'midnight' | 'parchment' | 'nord';

export const THEME_ORDER: readonly ThemeName[] = ['midnight', 'parchment', 'nord'];

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly ansi256: number;
}

export interface ThemePalette {
  readonly name: ThemeName;
  readonly label: string;
  readonly border: RgbColor;
  readonly borderActive: RgbColor;
  readonly headerBg: RgbColor;
  readonly headerFg: RgbColor;
  readonly statusBg: RgbColor;
  readonly statusFg: RgbColor;
  readonly selectionBg: RgbColor;
  readonly selectionFg: RgbColor;
  readonly text: RgbColor;
  readonly muted: RgbColor;
  readonly accent: RgbColor;
  readonly accentAlt: RgbColor;
  readonly dir: RgbColor;
  readonly success: RgbColor;
  readonly warning: RgbColor;
  readonly danger: RgbColor;
  readonly syntaxKeyword: RgbColor;
  readonly syntaxString: RgbColor;
  readonly syntaxNumber: RgbColor;
  readonly syntaxComment: RgbColor;
  readonly syntaxFunction: RgbColor;
  readonly syntaxType: RgbColor;
  readonly syntaxOperator: RgbColor;
  readonly syntaxTag: RgbColor;
  readonly syntaxAttr: RgbColor;
  readonly codeBg: RgbColor;
  readonly searchBg: RgbColor;
  readonly searchFg: RgbColor;
}

const c = (r: number, g: number, b: number, ansi256: number): RgbColor => ({ r, g, b, ansi256 });

export const THEMES: Readonly<Record<ThemeName, ThemePalette>> = {
  midnight: {
    name: 'midnight',
    label: 'Midnight',
    border: c(71, 85, 105, 240),
    borderActive: c(56, 189, 248, 39),
    headerBg: c(30, 41, 59, 236),
    headerFg: c(248, 250, 252, 255),
    statusBg: c(15, 23, 42, 234),
    statusFg: c(203, 213, 225, 252),
    selectionBg: c(30, 58, 138, 25),
    selectionFg: c(248, 250, 252, 255),
    text: c(226, 232, 240, 253),
    muted: c(148, 163, 184, 246),
    accent: c(56, 189, 248, 39),
    accentAlt: c(192, 132, 252, 177),
    dir: c(96, 165, 250, 75),
    success: c(74, 222, 128, 84),
    warning: c(250, 204, 21, 220),
    danger: c(248, 113, 113, 203),
    syntaxKeyword: c(192, 132, 252, 177),
    syntaxString: c(134, 239, 172, 114),
    syntaxNumber: c(251, 191, 36, 214),
    syntaxComment: c(120, 138, 160, 244),
    syntaxFunction: c(96, 165, 250, 75),
    syntaxType: c(45, 212, 191, 44),
    syntaxOperator: c(244, 114, 182, 205),
    syntaxTag: c(248, 113, 113, 203),
    syntaxAttr: c(251, 191, 36, 214),
    codeBg: c(23, 32, 48, 235),
    searchBg: c(234, 179, 8, 220),
    searchFg: c(15, 23, 42, 16),
  },
  parchment: {
    name: 'parchment',
    label: 'Parchment Light',
    border: c(168, 149, 118, 137),
    borderActive: c(169, 40, 29, 124),
    headerBg: c(238, 228, 206, 230),
    headerFg: c(44, 30, 22, 235),
    statusBg: c(228, 216, 192, 223),
    statusFg: c(44, 30, 22, 235),
    selectionBg: c(180, 83, 9, 130),
    selectionFg: c(255, 251, 235, 255),
    text: c(44, 30, 22, 235),
    muted: c(112, 92, 74, 242),
    accent: c(169, 40, 29, 124),
    accentAlt: c(146, 64, 14, 130),
    dir: c(29, 78, 216, 26),
    success: c(21, 128, 61, 28),
    warning: c(161, 98, 7, 136),
    danger: c(185, 28, 28, 160),
    syntaxKeyword: c(147, 51, 234, 92),
    syntaxString: c(21, 128, 61, 28),
    syntaxNumber: c(180, 83, 9, 130),
    syntaxComment: c(120, 113, 108, 243),
    syntaxFunction: c(29, 78, 216, 26),
    syntaxType: c(15, 118, 110, 30),
    syntaxOperator: c(190, 24, 93, 125),
    syntaxTag: c(185, 28, 28, 160),
    syntaxAttr: c(146, 64, 14, 130),
    codeBg: c(242, 234, 218, 254),
    searchBg: c(245, 158, 11, 214),
    searchFg: c(28, 25, 23, 16),
  },
  nord: {
    name: 'nord',
    label: 'Nord',
    border: c(76, 86, 106, 240),
    borderActive: c(136, 192, 208, 110),
    headerBg: c(46, 52, 64, 237),
    headerFg: c(236, 239, 244, 255),
    statusBg: c(59, 66, 82, 238),
    statusFg: c(216, 222, 233, 253),
    selectionBg: c(67, 76, 94, 239),
    selectionFg: c(136, 192, 208, 110),
    text: c(229, 233, 240, 254),
    muted: c(134, 148, 172, 245),
    accent: c(136, 192, 208, 110),
    accentAlt: c(180, 142, 173, 139),
    dir: c(129, 161, 193, 110),
    success: c(163, 190, 140, 108),
    warning: c(235, 203, 139, 222),
    danger: c(191, 97, 106, 167),
    syntaxKeyword: c(129, 161, 193, 110),
    syntaxString: c(163, 190, 140, 108),
    syntaxNumber: c(180, 142, 173, 139),
    syntaxComment: c(122, 136, 161, 244),
    syntaxFunction: c(136, 192, 208, 110),
    syntaxType: c(143, 188, 187, 109),
    syntaxOperator: c(208, 135, 112, 173),
    syntaxTag: c(129, 161, 193, 110),
    syntaxAttr: c(143, 188, 187, 109),
    codeBg: c(46, 52, 64, 237),
    searchBg: c(235, 203, 139, 222),
    searchFg: c(46, 52, 64, 16),
  },
};

export function supportsTrueColor(): boolean {
  const ct = (process.env.COLORTERM ?? '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return true;
  if (process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode') return true;
  return process.platform === 'win32' || process.platform === 'darwin';
}

export function getTheme(name?: string): ThemePalette {
  if (name === 'parchment' || name === 'nord' || name === 'midnight') {
    return THEMES[name];
  }
  return THEMES.midnight;
}

export function nextTheme(current: ThemeName): ThemeName {
  const idx = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(idx + 1) % THEME_ORDER.length] ?? 'midnight';
}

export function fg(color: RgbColor, trueColor = supportsTrueColor()): string {
  return trueColor
    ? `\x1b[38;2;${color.r};${color.g};${color.b}m`
    : `\x1b[38;5;${color.ansi256}m`;
}

export function bg(color: RgbColor, trueColor = supportsTrueColor()): string {
  return trueColor
    ? `\x1b[48;2;${color.r};${color.g};${color.b}m`
    : `\x1b[48;5;${color.ansi256}m`;
}
