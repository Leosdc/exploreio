# ◈ Exploreio — Explorador de Terminal estilo Yazi com Leitor Rico Nativo

Um gerenciador de arquivos para CLI/terminal inspirado no **Yazi**, projetado para **não apenas navegar pastas**, mas **abrir e renderizar arquivos com qualidade visual diretamente no prompt** — sem depender de `bat`, `glow`, `jq` ou editores externos.

## ✨ Destaques

- **Layout 3 Painéis estilo Yazi:** `Diretório Pai` | `Diretório Atual` | `Preview Rico ao Vivo` (responsivo para terminais estreitos).
- **Leitor Fullscreen Nativo no Prompt (`Enter`):**
  - **Markdown (`.md`, `.mdx`):** títulos estilizados, negrito/itálico/tachado, código inline, links, checklists (`☑`/`☐`), callouts GitHub (`[!NOTE]`, `[!TIP]`, `[!WARNING]`), tabelas Unicode alinhadas e blocos de código com syntax highlighting + toggle `Tab` (*Rendered* ↔ *Raw*).
  - **JSON (`.json`):** **Tree View interativa** (recolher/expandir nós com `Enter`/`←`/`→`, `e` expande tudo, `c` recolhe tudo) + modo *Pretty Highlighted* + diagnóstico visual de JSON inválido.
  - **HTML (`.html`, `.htm`):** **Modo Reader** limpo (extrai títulos, parágrafos, listas, links, citações, blocos de código e tabelas ignorando `<script>`/`<style>`) + toggle `Tab` para *Source* colorido.
  - **Código-Fonte:** syntax highlighting multi-linguagem leve (TS/JS, Python, Rust, Go, C/C++/Java/C#, CSS, SQL, YAML, TOML, Shell/PowerShell) com números de linha.
  - **Binários:** detecção de assinatura (PNG, JPEG, PDF, ZIP, WASM, ELF, EXE) + prévia segura em *Hex Dump*.
- **Modo Direto no Prompt (`--print` / `-p`):** renderize qualquer arquivo diretamente no stdout (`exploreio -p README.md`).
- **Editor Modal Estilo Vim Nativo (`e`):** edite qualquer arquivo de texto/código diretamente dentro do Exploreio com modos `NORMAL`, `INSERT`, `VISUAL`/`V-LINE`, `COMMAND` (`:w`, `:wq`, `:q!`, `:<linha>`) e `SEARCH` (`/`), undo/redo (`u`/`Ctrl+r`), syntax highlighting e preservação de EOL (`\r\n`/`\n`).
- **3 Temas Oficiais de Terminal (`t`):** `midnight`, `parchment` (claro) e `nord` com detecção Truecolor / ANSI 256.
- **Seguro por Padrão:** sanitização anti-ANSI-injection, limite de 2 MB contra OOM e confirmação obrigatória para exclusões.

## 🚀 Instalação & Comandos Globais (`exploreio` / `exp`)

```bash
npm install
npm run setup
```

O assistente `npm run setup` (também acionado automaticamente ao instalar em terminal interativo) pergunta se você deseja ativar os comandos globais **`exploreio`** e **`exp`** via `npm link` e permite escolher seu tema padrão (`midnight`, `parchment` ou `nord`), salvo em `~/.exploreiorc.json`.

Depois disso, basta abrir **qualquer pasta** no Windows Terminal, PowerShell, CMD, macOS ou Linux e rodar:

```bash
# Abrir TUI estilo Yazi no diretório atual
exploreio

# Abrir um arquivo direto no Leitor Fullscreen
exploreio README.md

# Imprimir renderizado direto no prompt (stdout)
exploreio -p README.md
exploreio -p package.json -m tree -t nord
exploreio -p index.html -m reader -t parchment
```

*(Também pode ser instalado globalmente direto via npm/GitHub: `npm install -g github:Leosdc/exploreio`.)*

## ⌨️ Principais Atalhos

| Contexto | Tecla | Ação |
| :--- | :--- | :--- |
| **Navegador** | `↑`/`↓` ou `j`/`k` | Mover seleção (roda do mouse suportada) |
| **Navegador** | `Enter` ou `→`/`l` | Entrar na pasta ou **abrir arquivo no Leitor Fullscreen** |
| **Navegador** | `←`/`h`/`Backspace` | Voltar para o diretório pai |
| **Navegador** | `/` ou `f` | Filtro fuzzy instantâneo no diretório atual |
| **Navegador** | `.` | Alternar arquivos ocultos |
| **Navegador / Leitor** | `y` | Copiar caminho completo selecionado (arquivo ou pasta) |
| **Navegador** | `a` / `r` / `d` | Criar / Renomear / Excluir (com confirmação) |
| **Navegador / Leitor** | `e` *(ou `E` no JSON Tree)* | Abrir arquivo no **Editor Modal Estilo Vim Nativo** |
| **Editor Vim** | `i`/`I`/`a`/`A`/`o`/`O` · `Esc` | Entrar em `INSERT` · voltar para `NORMAL` |
| **Editor Vim** | `v`/`V` · `dd`/`yy`/`p` · `u`/`Ctrl+r` | Seleção Visual · deletar/copiar/colar · Undo/Redo |
| **Editor Vim** | `:w` · `:wq` · `:q!` · `:<linha>` | Salvar · salvar e sair · descartar · ir para linha |
| **Leitor** | `Tab` | Alternar visualização (*Rendered↔Raw*, *Tree↔Pretty*, *Reader↔Source*) |
| **Leitor (JSON Tree)** | `Enter`/`←`/`→` · `e`/`c` | Abrir/fechar nó selecionado · expandir/recolher tudo |
| **Leitor** | `/` · `n`/`N` | Buscar texto no arquivo e navegar ocorrências |
| **Global** | `t` · `?` · `Esc`/`q` | Trocar tema · Ajuda · Voltar/Sair |

## 💡 Dica: Usando em Split no Windows Terminal

O layout do **Exploreio** se adapta ao vivo à largura do painel (`≥ 96` colunas exibe **3 painéis**; `60–95` colunas exibe **2 painéis**). Para abrir e ajustar painéis lado a lado no **Windows Terminal**:

| Atalho | Ação |
| :--- | :--- |
| `Alt + Shift + +` | Abrir novo painel vertical lado a lado (split) |
| `Alt + Shift + -` | Abrir novo painel horizontal |
| `Alt + Shift + ←`/`→`/`↑`/`↓` | Redimensionar o painel ativo (alterna 2 ↔ 3 painéis ao vivo) |
| `Alt + ←`/`→`/`↑`/`↓` | Alternar foco entre painéis sem usar o mouse |
| `Ctrl + Shift + W` | Fechar o painel ativo |
