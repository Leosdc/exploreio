# Changelog

Todas as alterações notáveis do **Exploreio** serão documentadas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/),
e este projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

---

## [0.1.0] - 2026-11-24

### Adicionado
- Motor TUI 3 painéis estilo Yazi (`Pai | Atual | Preview Rico`) com buffer duplo ANSI sem flicker e suporte a roda do mouse SGR (`src/tui/`).
- Modo Leitor Fullscreen nativo no prompt com alternância `Tab` e busca interna (`/`, `n`/`N`) para Markdown rico, JSON Tree interativo/Pretty, HTML Reader/Source, Código-Fonte (syntax highlighting) e Binários (assinatura + Hex Dump).
- 3 temas oficiais de terminal (`midnight`, `parchment`, `nord`) com detecção Truecolor e fallback ANSI 256 (`src/themes/palette.ts`).
- Cópia rápida de caminho completo selecionado (`y`) para arquivos e pastas via `stdin` sem shell + fallback OSC 52 (`src/tui/clipboard.ts`).
- Modo CLI direto (`exploreio -p <arquivo>`), assistente de instalação global (`npm run setup` para `exploreio` e `exp`) e suíte de testes unitários (`node --test`).
