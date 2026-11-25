# Changelog

Todas as alterações notáveis do **Exploreio** serão documentadas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/),
e este projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

---

## [0.3.0] - 2026-11-25

### Adicionado
- **Interpretador e Renderizador Nativo de Mermaid (`.mmd`, `.mermaid` e blocos ```` ```mermaid ```` em Markdown):** parser AST zero-dependências (`src/renderers/mermaidParser.ts`) e motor de layout Unicode/ANSI multi-tema (`src/renderers/mermaid.ts`) com suporte a `flowchart`/`graph` (`TD`/`TB`/`LR`/`RL`/`BT`, formas de nós, rótulos de arestas, `subgraph` e detecção segura de ciclos), `sequenceDiagram` (lifelines, setas, notas, blocos `alt`/`else`/`loop` e modo compacto), `stateDiagram-v2`, `classDiagram` e `erDiagram`, com degradação segura (fail-safe), limites anti-OOM e sanitização anti-ANSI-injection nos 3 temas oficiais (#8, #9).

## [0.2.0] - 2026-11-25

### Adicionado
- **Editor Modal Estilo Vim Nativo (`e` no Navegador/Leitor, `E` no JSON Tree):** suporte completo aos modos `NORMAL`, `INSERT`, `VISUAL`, `VISUAL LINE`, `COMMAND` e `SEARCH`, motions (`hjkl`, `w/b/e`, `0/^/$`, `gg/G`, `Ctrl+d/u`, contagem numérica), operadores (`i/I/a/A/o/O`, `x`, `dd`, `yy`, `p/P`, `r`, `J`, `D`, `C`, `cc`, `u`/`Ctrl+r`), comandos (`:w`, `:q`, `:wq`, `:x`, `:q!`, `:<linha>`, `:set nu/nonu`), preservação de EOL (`\r\n`/`\n`), sanitização anti-ANSI-injection e conformidade total com os 3 temas oficiais (#4, #5).
- **Preparação para publicação no npm (`exploreio`):** adição dos metadados `repository`, `homepage` e `bugs` no `package.json` e atualização das instruções de instalação global (`npm install -g exploreio` / `npx exploreio`) no `README.md`.

## [0.1.1] - 2026-11-24

### Documentação
- Adicionada seção de dicas de uso em split no **Windows Terminal** (`Alt + Shift + +`, `Alt + Shift + -`, `Alt + Shift + ←/→/↑/↓`, `Alt + ←/→/↑/↓` e `Ctrl + Shift + W`) e detalhamento do comportamento responsivo de painéis (`≥ 96` colunas: 3 painéis; `60–95` colunas: 2 painéis) no `README.md` (#1).

## [0.1.0] - 2026-11-24

### Adicionado
- Motor TUI 3 painéis estilo Yazi (`Pai | Atual | Preview Rico`) com buffer duplo ANSI sem flicker e suporte a roda do mouse SGR (`src/tui/`).
- Modo Leitor Fullscreen nativo no prompt com alternância `Tab` e busca interna (`/`, `n`/`N`) para Markdown rico, JSON Tree interativo/Pretty, HTML Reader/Source, Código-Fonte (syntax highlighting) e Binários (assinatura + Hex Dump).
- 3 temas oficiais de terminal (`midnight`, `parchment`, `nord`) com detecção Truecolor e fallback ANSI 256 (`src/themes/palette.ts`).
- Cópia rápida de caminho completo selecionado (`y`) para arquivos e pastas via `stdin` sem shell + fallback OSC 52 (`src/tui/clipboard.ts`).
- Modo CLI direto (`exploreio -p <arquivo>`), assistente de instalação global (`npm run setup` para `exploreio` e `exp`) e suíte de testes unitários (`node --test`).
