# ◈ Exploreio — Explorador de Terminal estilo Yazi com Leitor Rico Nativo

Um gerenciador de arquivos para CLI/terminal inspirado no **Yazi**, projetado para **não apenas navegar pastas**, mas **abrir e renderizar arquivos com qualidade visual diretamente no prompt** — sem depender de `bat`, `glow`, `jq` ou editores externos.

## ✨ Destaques

- **Layout 3 Painéis estilo Yazi:** `Diretório Pai` | `Diretório Atual` | `Preview Rico ao Vivo` (responsivo para terminais estreitos).
- **Leitor Fullscreen Nativo no Prompt (`Enter`):**
  - **Markdown (`.md`, `.mdx`):** títulos estilizados, negrito/itálico/tachado, código inline, links, checklists (`☑`/`☐`), callouts GitHub (`[!NOTE]`, `[!TIP]`, `[!WARNING]`), tabelas Unicode alinhadas, **diagramas Mermaid renderizados inline** e blocos de código com syntax highlighting + toggle `Tab` (*Rendered* ↔ *Raw*).
  - **Mermaid (`.mmd`, `.mermaid`):** renderização 2D Unicode/ANSI alimentada pelo motor oficial [**`@leosdc/termaid`**](https://github.com/Leosdc/termaid) (layout Sugiyama, subgraphs reais e roteamento ortogonal) para `flowchart`/`graph`, `sequenceDiagram`, `stateDiagram`, `classDiagram`, `erDiagram`, **`timeline`** e **`gitGraph`**, com adaptação à largura do terminal, fallback seguro e toggle `Tab` (*Diagram* ↔ *Raw*).
  - **JSON (`.json`):** **Tree View interativa** (recolher/expandir nós com `Enter`/`←`/`→`, `e` expande tudo, `c` recolhe tudo) + modo *Pretty Highlighted* + diagnóstico visual de JSON inválido.
  - **HTML (`.html`, `.htm`):** **Modo Reader** limpo (extrai títulos, parágrafos, listas, links, citações, blocos de código e tabelas ignorando `<script>`/`<style>`) + toggle `Tab` para *Source* colorido.
  - **Código-Fonte:** syntax highlighting multi-linguagem leve (TS/JS, Python, Rust, Go, C/C++/Java/C#, CSS, SQL, YAML, TOML, Shell/PowerShell) com números de linha.
  - **Binários:** detecção de assinatura (PNG, JPEG, PDF, ZIP, WASM, ELF, EXE) + prévia segura em *Hex Dump*.
- **Modo Direto no Prompt (`--print` / `-p`):** renderize qualquer arquivo diretamente no stdout (`exploreio -p README.md`).
- **Editor Modal Estilo Vim Nativo (`e`):** edite qualquer arquivo de texto/código diretamente dentro do Exploreio com modos `NORMAL`, `INSERT`, `VISUAL`/`V-LINE`, `COMMAND` (`:w`, `:wq`, `:q!`, `:<linha>`) e `SEARCH` (`/`), undo/redo (`u`/`Ctrl+r`), syntax highlighting e preservação de EOL (`\r\n`/`\n`).
- **Painel Git & GitHub Nativo (`Tab` ou `Ctrl+G`):** badge discreto de branch/pendências no cabeçalho do navegador (`⎇ branch ↑N ●M`) + tela dedicada com 4 abas (**Status & Commits Parados**, **Árvore de Commits**, **Branches** e **GitHub PRs/Issues/Actions via `gh` CLI**), diff ao vivo, barra de botões rápidos e paleta interativa (`?`) para `git pull`, `git push`, `git fetch`, `git commit`, `git branch` e `git stash`.
- **Keybinds 100% Customizáveis (`K` ou `Ctrl+K`):** personalize qualquer atalho pelo **Painel Interativo de Edição de Binds** direto na TUI (com captura de tecla ao vivo e detecção de conflitos) ou editando o arquivo de configuração base `~/.exploreiorc.json` (`exploreio --init-config`).
- **Criação Rápida de Arquivos, Pastas & Duplicação Cross-OS (`n`, `N`/`m`, `c`):** modal interativo para criar arquivos com seletor rápido de extensões (`Tab`/`Shift+Tab`/`↑`/`↓`) ou escrita livre de extensão customizada, preview em tempo real e toggle `Ctrl+E` para criar e já abrir no Editor Vim; criação recursiva de subpastas (`a/b/c`) e duplicação segura incremental validada para Windows, macOS e Linux.
- **3 Temas Oficiais de Terminal (`t`):** `midnight`, `parchment` (claro) e `nord` com detecção Truecolor / ANSI 256.
- **Seguro por Padrão:** sanitização anti-ANSI-injection, limite de 2 MB contra OOM e confirmação obrigatória para exclusões.

## 🚀 Instalação & Comandos Globais (`exploreio` / `exp`)

### Via npm (Recomendado)

O pacote [**`@leosdc/termaid`**](https://github.com/Leosdc/termaid) é dependência direta do Exploreio e é instalado automaticamente junto com o CLI para renderização de diagramas Mermaid (`.mmd`, `.mermaid` e blocos ` ```mermaid ` em Markdown).

```bash
# Instalação global (ativa os comandos `exploreio` e `exp` + instala `@leosdc/termaid`)
npm install -g @leosdc/exploreio

# (Opcional) Instale também a CLI standalone do Termaid se quiser rodar `termaid` direto no prompt
npm install -g @leosdc/termaid

# Ou execute sem instalar
npx @leosdc/exploreio
```

Depois disso, basta abrir **qualquer pasta** no Windows Terminal, PowerShell, CMD, macOS ou Linux e rodar:

```bash
# Abrir TUI estilo Yazi no diretório atual
exploreio

# Abrir um arquivo direto no Leitor Fullscreen
exploreio README.md

# Imprimir renderizado direto no prompt (stdout)
exploreio -p README.md
exploreio -p diagrama.mmd
exploreio -p package.json -m tree -t nord
exploreio -p index.html -m reader -t parchment
```

### A partir do código-fonte (Desenvolvimento Local)

```bash
# Instala as dependências (incluindo `@leosdc/termaid`) e prepara o projeto
npm install
npm run setup
```

O assistente `npm run setup` (também acionado automaticamente ao instalar localmente em terminal interativo) pergunta se você deseja ativar os comandos globais **`exploreio`** e **`exp`** via `npm link` e permite escolher seu tema padrão (`midnight`, `parchment` ou `nord`), salvo em `~/.exploreiorc.json`.

## 🧩 Dependência de Renderização Mermaid (`@leosdc/termaid`)

A renderização de diagramas Mermaid no **Exploreio** é delegada ao pacote oficial [**`@leosdc/termaid`**](https://github.com/Leosdc/termaid) ([npm](https://www.npmjs.com/package/@leosdc/termaid)), declarado em `dependencies` no `package.json`:

- **Tipos suportados:** `flowchart` / `graph` (com `subgraph`), `sequenceDiagram`, `stateDiagram`, `classDiagram`, `erDiagram`, `timeline` e `gitGraph`.
- **Fallback seguro:** tipos ainda não suportados pelo Termaid (ex.: `gantt`, `pie`) exibem aviso discreto e o código-fonte destacado sem quebrar a leitura do documento.
- **Temas sincronizados:** os 3 temas do Exploreio (`midnight`, `parchment`, `nord`) são repassados automaticamente para o motor do Termaid.

## ⌨️ Principais Atalhos

| Contexto | Tecla | Ação |
| :--- | :--- | :--- |
| **Navegador** | `↑`/`↓` ou `j`/`k` | Mover seleção (roda do mouse suportada) |
| **Navegador** | `Enter` ou `→`/`l` | Entrar na pasta ou **abrir arquivo no Leitor Fullscreen** |
| **Navegador** | `←`/`h`/`Backspace` | Voltar para o diretório pai |
| **Navegador** | `/` ou `f` | Filtro fuzzy instantâneo no diretório atual |
| **Navegador** | `.` | Alternar arquivos ocultos |
| **Navegador / Leitor** | `o` ou `F` | Abrir arquivo em **novo terminal em tela cheia** (ideal em painel splitado) |
| **Navegador / Leitor** | `y` | Copiar caminho completo selecionado (arquivo ou pasta) |
| **Navegador** | `n` / `N` (`m`) | **Novo arquivo** (com seletor/escrita de extensão e abrir no Vim) / **Nova pasta** (subpastas cross-OS) |
| **Navegador** | `c` / `a` / `r` / `d` | Duplicar / Criar rápido / Renomear / Excluir (com confirmação) |
| **Navegador** | `Tab` ou `Ctrl+G` | Abrir **Painel Git & GitHub** (status, commits parados, árvore, branches e PRs) |
| **Painel Git** | `1`–`4` / `Tab` · `↑`/`↓` · `J`/`K` | Trocar aba · selecionar item · rolar diff/detalhes |
| **Painel Git** | `s`/`S`/`c` · `p`/`P`/`f`/`b` · `?` | Stage/All/Commit · Pull/Push/Fetch/+Branch · **Paleta de Comandos Rápidos** |
| **Navegador / Leitor** | `e` *(ou `E` no JSON Tree)* | Abrir arquivo no **Editor Modal Estilo Vim Nativo** |
| **Editor Vim** | `i`/`I`/`a`/`A`/`o`/`O` · `Esc` | Entrar em `INSERT` · voltar para `NORMAL` |
| **Editor Vim** | `v`/`V` · `dd`/`yy`/`p` · `u`/`Ctrl+r` | Seleção Visual · deletar/copiar/colar · Undo/Redo |
| **Editor Vim** | `:w` · `:wq` · `:q!` · `:<linha>` | Salvar · salvar e sair · descartar · ir para linha |
| **Leitor** | `Tab` | Alternar visualização (*Rendered↔Raw*, *Tree↔Pretty*, *Reader↔Source*) |
| **Leitor (JSON Tree)** | `Enter`/`←`/`→` · `e`/`c` | Abrir/fechar nó selecionado · expandir/recolher tudo |
| **Leitor** | `/` · `n`/`N` | Buscar texto no arquivo e navegar ocorrências |
| **Global** | `K` ou `Ctrl+K` | Abrir **Painel Interativo de Edição de Keybinds** (também acessível dentro do `?`) |
| **Global** | `t` · `?` · `Esc`/`q` | Trocar tema · Ajuda dinâmica · Voltar/Sair |

## 🎛️ Customização de Keybinds & Arquivo de Config Base

Todos os atalhos de navegação, leitura e Painel Git podem ser personalizados do jeito que você preferir, de duas formas:

### 1. Painel Interativo na TUI (`K` ou `Ctrl+K`)
Pressione **`K`** ou **`Ctrl+K`** (ou abra a ajuda **`?`** e pressione **`K`**) para abrir o **Painel de Edição de Keybinds**:
- **`1`–`5` / `Tab`:** filtrar por contexto (*Todos*, *Global*, *Navegador*, *Leitor*, *Painel Git*)
- **`/`:** buscar ações por nome, descrição ou tecla atual
- **`Enter`:** captura ao vivo da nova tecla principal (`Esc` cancela)
- **`+` ou `a`:** adicionar tecla alternativa para a mesma ação
- **`d` ou `Backspace`:** remover última tecla da ação
- **`r` / `R`:** restaurar ação selecionada / restaurar todos os padrões (com confirmação)
- **`s`:** salvar imediatamente em `~/.exploreiorc.json` *(ao sair com `Esc`/`q`, alterações pendentes também são salvas)*
- Conflitos dentro do mesmo contexto são destacados automaticamente com `⚠`, e o modal de ajuda **`?`** (assim como `exploreio --help`) passa a exibir seus atalhos personalizados em tempo real.

### 2. Arquivo de Configuração Base (`~/.exploreiorc.json`)
Você pode gerar o arquivo de configuração base completo com todos os binds padrão executando:

```bash
# Gera/atualiza ~/.exploreiorc.json preservando seu tema e binds já customizados
exploreio --init-config

# Redefine todos os binds para o padrão no ~/.exploreiorc.json
exploreio --init-config --force

# (Opcional) Executar o Exploreio apontando para outro arquivo de config
exploreio --config ./meu-exploreiorc.json
```

Veja o modelo completo versionado em [`exploreiorc.example.json`](./exploreiorc.example.json). Exemplo resumido:

```json
{
  "theme": "midnight",
  "keybinds": {
    "global": {
      "quit": ["q"],
      "help": ["?"],
      "openKeybinds": ["K", "ctrl+k"],
      "cycleTheme": ["t"]
    },
    "browser": {
      "moveUp": ["up", "k"],
      "moveDown": ["down", "j"],
      "open": ["enter", "right", "l"],
      "openGitPanel": ["tab", "ctrl+g"]
    }
  }
}
```

**Sintaxe de teclas aceitas:** `up`, `down`, `left`, `right`, `enter`, `tab`, `shift+tab`, `escape`, `backspace`, `delete`, `space`, `pageup`, `pagedown`, `home`, `end`, combinações `ctrl+<letra>` (ex.: `ctrl+g`, `ctrl+k`) e caracteres imprimíveis diferenciando maiúsculas e minúsculas (`j` ≠ `J`). `Ctrl+C` permanece sempre reservado como saída de emergência.

## 💡 Dica: Usando em Split no Windows Terminal

O layout do **Exploreio** se adapta ao vivo à largura do painel (`≥ 96` colunas exibe **3 painéis**; `60–95` colunas exibe **2 painéis**). Para abrir e ajustar painéis lado a lado no **Windows Terminal**:

| Atalho | Ação |
| :--- | :--- |
| `Alt + Shift + +` | Abrir novo painel vertical lado a lado (split) |
| `Alt + Shift + -` | Abrir novo painel horizontal |
| `Alt + Shift + ←`/`→`/`↑`/`↓` | Redimensionar o painel ativo (alterna 2 ↔ 3 painéis ao vivo) |
| `Alt + ←`/`→`/`↑`/`↓` | Alternar foco entre painéis sem usar o mouse |
| `Ctrl + Shift + W` | Fechar o painel ativo |
