<p align="center">
  <img src="claude_dock/ui/icon.svg" width="96" alt="Ícone do Claude Dock">
</p>

<h1 align="center">Claude Dock</h1>

<p align="center">
  <strong>Todas as sessões do <a href="https://claude.com/claude-code">Claude Code</a> que você tem abertas, o histórico inteiro das suas conversas e quanto ainda resta do seu plano, a um passar de mouse.</strong><br>
  Uma ilhinha embaixo do top bar do GNOME que vira um painel quando você aponta pra ela.
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>Português</strong>
</p>

<p align="center">
  <img alt="Linux X11" src="https://img.shields.io/badge/Linux-X11-FCC624?logo=linux&logoColor=black">
  <img alt="GNOME" src="https://img.shields.io/badge/GNOME-top%20bar-4A86CF?logo=gnome&logoColor=white">
  <img alt="Python" src="https://img.shields.io/badge/Python-3.8%2B-3776AB?logo=python&logoColor=white">
  <img alt="Sem hooks" src="https://img.shields.io/badge/Claude%20Code-sem%20hooks-D97757">
  <img alt="pip install" src="https://img.shields.io/badge/pip%20install-nenhum-success">
  <img alt="Licença MIT" src="https://img.shields.io/badge/licen%C3%A7a-MIT-blue">
</p>

<p align="center">
  <img src="docs/pt/demo.gif" width="720" alt="Passar o mouse na ilha abre o painel com as sessões abertas, as recentes com busca e o uso do plano">
</p>

## 💡 Pra que serve

Quem roda o Claude Code em mais de um lugar conhece a rotina. Uma sessão está numa aba do terminal, outras duas estão dentro do RubyMine, e mais uma terminou faz dez minutos e está te esperando desde então. Achar a certa é ficar dando alt-tab em tudo, e ver quanto sobrou da janela de 5 horas é abrir mais uma coisa.

O Claude Dock junta tudo isso num lugar só, logo abaixo do relógio. A ilha mostra uma bolinha por sessão rodando (🟠 laranja enquanto trabalha, 🟢 verde quando está livre, 🟡 amarela quando está esperando você) ao lado do seu consumo atual. Aponte pra ela e o painel abre. Clique numa sessão e a janela dela vem pra frente.

<p align="center">
  <img src="docs/pt/island.png" width="400" alt="A ilha: uma bolinha por sessão e a porcentagem de uso">
</p>

## O que tem no painel

<p align="center">
  <img src="docs/pt/hero.png" width="860" alt="Painel com as sessões abertas à esquerda e o uso do plano à direita">
</p>

À esquerda ficam todas as sessões do Claude Code rodando agora, com o app onde cada uma está: Ghostty, RubyMine e as outras IDEs da JetBrains, VS Code ou um terminal comum. As que estão trabalhando mostram um cronômetro de quanto tempo estão nisso. Clicou, o Claude Dock traz aquela janela exata pra frente.

À direita fica o uso do seu plano. A sessão de 5 horas (quando a sua conta tem) e o limite semanal aparecem em anéis e barras, cada um com a contagem até resetar. O tracinho na barra marca quanto daquela janela já passou, então dá pra ver de relance se você está gastando mais rápido que o relógio.

### Volte de onde parou

<p align="center">
  <img src="docs/pt/recent.png" width="860" alt="Sessões recentes agrupadas por dia, filtradas pela palavra api com o trecho realçado">
</p>

A aba Recentes lista as sessões anteriores agrupadas por dia, com o título de verdade de cada uma. Digite pra filtrar por título ou projeto e o trecho encontrado acende. Clicar numa delas abre um terminal naquela pasta rodando `claude --resume` daquela sessão, ou copia o comando, se você preferir assim nas configurações.

### Comece uma nova

<p align="center">
  <img src="docs/pt/new-session.png" width="860" alt="Folha de nova sessão com as pastas de projeto recentes">
</p>

O botão + lista as pastas que você usou por último. Escolha uma, ou procure qualquer outra, e um terminal abre lá com o `claude` já rodando.

### Mostre só o que importa pra você

<p align="center">
  <img src="docs/pt/settings.png" width="860" alt="Configurações com chaves de liga e desliga">
</p>

A engrenagem abre as configurações. A primeira opção escolhe o que o clique numa sessão recente faz: abrir o terminal, copiar `claude --resume` ou copiar `/resume`. Também dá pra esconder o uso da ilha, desligar o aviso de atualização e ligar ou desligar cada parte do painel de uso: selo do plano, anéis, sessão de 5h, semana, marcador de tempo e quando reseta. Dois extras começam desligados e podem ser ativados ali: os limites semanais por modelo e a divisão de onde o consumo foi gasto (Claude Code, chats, Cowork). O idioma segue o do sistema, e também dá pra trocar ali.

## 🗂️ Seu histórico inteiro, organizado

Todo projeto tem um custo escondido: **reaquecer o contexto**. Cada vez que você abre um Claude do zero, vai tempo explicando de novo a arquitetura, dizendo onde parou, apontando os arquivos que importam. Quando o terminal fecha, o contexto que ele acabou de montar vai junto.

O Claude Code já guarda cada conversa pra você retomar. O difícil é achar a certa no meio de dezenas de IDs que não dizem nada. Por isso o Claude Dock traz uma janela com todas as conversas que você já teve.

> **Retomar custa segundos. Recomeçar custa horas.**

<p align="center">
  <img src="docs/pt/library.png" width="860" alt="Janela de sessões com os projetos na lateral e as conversas em cards agrupadas por projeto">
</p>

Ela abre por "Ver todas as sessões", que fica fixo no pé do painel. As conversas aparecem em cards agrupados por projeto, cada um com o título, a primeira mensagem ou a sua anotação, a branch, quanto do contexto estava ocupado e quando foi a última atividade. As sessões rodando agora ganham o selo de status, e clicar numa delas leva até a janela dela em vez de abrir uma segunda cópia.

### Ache pela palavra que você lembra

<p align="center">
  <img src="docs/pt/library-search.png" width="860" alt="Busca que achou uma sessão por uma palavra no meio da conversa">
</p>

A busca filtra por nome, nota, projeto e branch enquanto você digita. Um instante depois ela também procura dentro do que foi conversado e mostra o trecho que achou. Aquela sessão em que vocês falaram do heap snapshot fica a uma palavra de distância.

### Do seu jeito: abrir ou copiar

<p align="center">
  <img src="docs/pt/library-menu.png" width="860" alt="Menu do botão direito com retomar, copiar claude --resume, copiar /resume, copiar ID, renomear, favoritar e lixeira">
</p>

Você escolhe o que o clique faz: abrir um terminal com a conversa retomada, copiar `cd pasta && claude --resume id` pra colar em qualquer terminal, ou copiar `/resume id` pra colar num Claude que já está aberto. A escolha vale pro painel e pra janela. O botão direito tem as três opções sempre à mão, junto com renomear, favoritar e mandar pra lixeira.

<p align="center">
  <img src="docs/pt/library-settings.png" width="860" alt="Configurações da janela com a escolha do clique e a lixeira automática">
</p>

### Arrume várias de uma vez

<p align="center">
  <img src="docs/pt/library-select.png" width="860" alt="Três cards selecionados e a barra preta com favoritar e mandar pra lixeira">
</p>

Marque o círculo de um card, segure Shift pra pegar um intervalo, e uma barra aparece embaixo pra favoritar ou mandar tudo pra lixeira. Se você se arrepender, cada ação tem Desfazer. A lixeira só esconde: os arquivos das conversas continuam em `~/.claude` e voltam quando você quiser. Dá até pra ligar a lixeira automática pra sessões paradas há 30, 60 ou 90 dias (favoritas nunca vão).

| | |
|---|---|
| 🔁 **Retomar com um clique** | Abre o terminal na pasta certa, ou copia o comando, como você preferir |
| 📋 **Formato da cópia** | `claude --resume` pro terminal ou `/resume` pra dentro do Claude |
| 🏷️ **Nomes e anotações** | Um nome de gente pra cada conversa e uma nota de onde você parou |
| ⭐ **Favoritas** | As conversas de todo dia sempre à mão |
| 🔍 **Busca no texto** | Acha pelo que foi dito na conversa, com o trecho realçado |
| 🟢 **Abertas agora** | Sessões rodando aparecem marcadas e o clique vai pra janela delas |
| 🌡️ **Contexto à vista** | Conversas perto de estourar o contexto aparecem em amarelo e vermelho |
| ↕️ **Ordenação** | Mais recentes, mais antigas, maior contexto, maior arquivo ou nome |
| ☑️ **Seleção em lote** | Favorite ou mande pra lixeira várias de uma vez, com Desfazer |
| 🗑️ **Lixeira segura** | Só esconde, nada é apagado do disco. Tem lixeira automática opcional |
| ⌨️ **Teclado** | `/` busca, setas andam pelos cards, Enter faz o mesmo que o clique, `c` copia, `e` edita, `f` favorita |

Se você usa o [Claude Sessions Manager](https://github.com/krugerrgabriel/claude-sessions-manager), a janela lê e grava o mesmo arquivo que ele, e os cards seguem a mesma estrutura. Nomes, notas, favoritas e lixeira ficam iguais nos dois, então dá pra usar um, o outro ou os dois. Sem ele, o dock guarda uma cópia própria no mesmo formato.

## Recursos

| | |
|---|---|
| Sessões ao vivo | Lê o que o Claude Code já grava em `~/.claude`. Não tem nada pra configurar nem hook pra instalar |
| Vai até a janela | Liga cada sessão à sua janela pela árvore de processos e pelo título, e traz ela pra frente com o `wmctrl` |
| Retoma do histórico | Abre um terminal na pasta certa com `claude --resume <id>`, ou copia `claude --resume` ou `/resume` |
| Nova sessão | Pastas recentes, ou qualquer pasta pelo seletor de arquivos |
| Uso do plano | Limites de 5 horas e semanal, contagem até o reset, limites por modelo e onde foi gasto |
| Busca | Filtra as sessões anteriores por título ou projeto e realça o trecho encontrado |
| Todas as sessões | Uma janela com o histórico inteiro em cards: nomes, notas, favoritas, lixeira, seleção em lote, ordenação e busca dentro das conversas |
| Não atrapalha | O clique passa direto em tudo, menos na ilha e no painel aberto. O foco do teclado volta pra janela em que você estava quando o painel fecha |
| Leve | Biblioteca padrão do Python mais o GTK e o WebKit que o seu desktop já tem. O uso é consultado a cada 2 minutos, ou na hora quando você clica em atualizar |
| Se atualiza | Avisa quando sai versão nova e instala com um clique |
| Dois idiomas | Inglês e português, seguindo o idioma do sistema |

## 📦 Instalação

```bash
curl -fsSL https://raw.githubusercontent.com/krugerrgabriel/claude-dock/main/install.sh | sh
```

Essa linha baixa a última versão em `~/.local/share/claude-dock` e instala os três pacotes do sistema que ele precisa, caso falte algum (o apt vai pedir sua senha). Depois cria um atalho no menu de apps, configura o dock pra abrir junto com o login e já inicia ele. Pra atualizar, rode a mesma linha de novo.

Você precisa de Linux numa sessão X11 e do Claude Code logado na máquina. Ele foi feito e testado no Ubuntu 24.04 com GNOME 46. Os pacotes são `python3-gi`, `gir1.2-webkit2-4.1` e `wmctrl`, e a maioria dos desktops Ubuntu já vem com os dois primeiros.

<details>
<summary>Instalar a partir do código</summary>

```bash
sudo apt install python3-gi gir1.2-webkit2-4.1 wmctrl
git clone https://github.com/krugerrgabriel/claude-dock.git
cd claude-dock
python3 install.py
```

O `install.py` cria o comando `claude-dock` em `~/.local/bin`, o atalho no menu de apps e a entrada de inicialização automática, e depois inicia o dock. Use `--no-start` se preferir iniciar você mesmo.

Pra testar sem instalar nada, rode `./claude-dock` dentro da pasta clonada.
</details>

<details>
<summary>Desinstalar</summary>

```bash
python3 ~/.local/share/claude-dock/install.py --uninstall
```

Fecha o dock e remove o comando, o atalho do menu e a inicialização automática. Suas configurações ficam em `~/.config/claude-dock`, caso você volte.
</details>

## 🔄 Atualizações

O Claude Dock consulta o GitHub atrás de versão nova quando abre e depois a cada 6 horas. Quando sai uma, aparece uma setinha azul na ilha, e a coluna de uso ganha um cartão no topo. Clique em Atualizar e o dock baixa a versão, troca os arquivos e reabre sozinho. Se não quiser o aviso, desligue "Avisar atualizações" nas configurações.

<p align="center">
  <img src="docs/pt/island-update.png" width="400" alt="A ilha com a seta azul de atualização"><br>
  <img src="docs/pt/update.png" width="350" alt="Cartão de atualização no topo da coluna de uso">
</p>

## Como usar

| Ação | O que acontece |
|---|---|
| Apontar pra ilha | O painel abre depois de uma pausa curta, pra não abrir quando você só passa a caminho do relógio |
| Tirar o mouse | O painel fecha |
| Clicar numa sessão aberta | A janela dela vem pra frente |
| Clicar numa sessão recente | Abre um terminal naquela pasta retomando a sessão. Nas configurações dá pra trocar por copiar `claude --resume` ou `/resume`, e a janela de sessões segue a mesma escolha |
| + | Nova sessão numa pasta recente ou em qualquer pasta que você escolher |
| Engrenagem | Configurações |
| Seta de atualizar | Consulta o uso na hora |
| Ver todas as sessões | Abre a janela de sessões, ou traz ela pra frente se já estiver aberta |
| `/` na janela de sessões | Vai pra busca. As setas andam entre as cards, Enter faz o mesmo que o clique, `e` edita, `f` marca com estrela, Delete manda pra lixeira, `c` copia o comando de retomar |
| Botão direito numa sessão | Menu com retomar, copiar `claude --resume`, `/resume` ou o ID, renomear, favoritar, selecionar e lixeira |

## Arquivo de configuração

Tudo o que você muda nas configurações fica salvo em `~/.config/claude-dock/config.json`. Algumas chaves só existem no arquivo:

```json
{
  "terminal": "ghostty"
}
```

`terminal` escolhe o terminal das sessões novas e retomadas: `ghostty`, `kitty`, `wezterm`, `alacritty`, `ptyxis`, `gnome-terminal` ou `konsole`. Sem ela, o Claude Dock usa o primeiro que encontrar nessa ordem. Reinicie o dock depois de editar o arquivo na mão.

O Claude Dock acha o Claude Sessions Manager pela configuração do Apache. Se você instalou num lugar diferente, coloque em `sessionsManagerDir` a pasta da instalação (a que tem `app.wsgi` e `data/`).

## Como funciona

```
~/.claude/sessions/<pid>.json        sessões rodando agora (o Claude Code mantém atualizado)
~/.claude/projects/*/<id>.jsonl      transcripts: título, pasta, branch, primeira mensagem
~/.claude/.credentials.json          o token que o Claude Code já usa, pra consulta de uso
            │
            ▼
claude_dock/   sessions.py   sessões ao vivo e histórico, lidos direto do disco
               windows.py    acha e traz pra frente a janela certa (wmctrl)
               launch.py     abre um terminal rodando claude ou claude --resume
               usage.py      uso do plano em api.anthropic.com
               library.py    todas as conversas, nomes e notas, busca dentro dos transcripts
               app.py        janela GTK transparente embaixo do top bar, com um WebKit dentro
               ui/           a ilha e o painel (HTML, CSS, JS)
```

A janela é transparente e tem tamanho fixo. A página avisa o Python qual retângulo pode receber clique a cada momento (a ilha quando fechado, o painel quando aberto), e o input shape do X11 deixa todos os outros cliques passarem pro que estiver embaixo.

## 🔒 Privacidade

Os dados das sessões não saem da sua máquina. O Claude Dock faz duas requisições de rede. Uma é a consulta de uso, `GET https://api.anthropic.com/api/oauth/usage`, feita com o token que o Claude Code já guarda em `~/.claude/.credentials.json`. A outra pergunta ao GitHub qual é a última versão (`api.github.com/repos/krugerrgabriel/claude-dock/releases/latest`) e não envia nada sobre você. Dos seus transcripts, o Claude Dock lê o título da sessão, a pasta, a branch do git e a primeira mensagem (usada como nome quando a sessão ainda não tem título). A janela de sessões também lê os transcripts inteiros quando você busca dentro deles, na sua máquina. O Claude Dock nunca escreve nada dentro de `~/.claude`: nomes, notas, favoritas e a lixeira vão pro `data/metadata.json` do Claude Sessions Manager quando ele está instalado, ou pra `~/.local/share/claude-dock/metadata.json` quando não está. A lixeira só esconde a sessão. O arquivo dela continua onde estava. Pra abrir rápido, o dock guarda o que leu de cada transcript (título, pasta, branch, primeira mensagem, tamanho) em `~/.cache/claude-dock/transcripts.json`. Dá pra apagar esse arquivo quando quiser.

## Problemas comuns

<details>
<summary>A ilha não aparece</summary>

Veja o tipo da sua sessão com `echo $XDG_SESSION_TYPE`. O Claude Dock precisa de `x11`. No Wayland, o GNOME não deixa uma janela se posicionar sozinha nem trazer outras janelas pra frente. Escolha "Ubuntu on Xorg" na tela de login.
</details>

<details>
<summary>Clicar numa sessão não traz a janela pra frente</summary>

Confira se o `wmctrl` está instalado (`sudo apt install wmctrl`). Num terminal com abas, o dock traz a janela, e só consegue saber qual aba tem a sessão quando ela é a aba ativa. No terminal de dentro de uma IDE da JetBrains, ele traz a janela do projeto.
</details>

<details>
<summary>O painel de uso mostra um erro</summary>

"Credencial vencida" ou "Token expirou" quer dizer que o token em `~/.claude/.credentials.json` está velho. Abra o Claude Code num terminal uma vez e ele renova. "Muitas consultas" se resolve sozinho, porque o dock espera mais entre uma tentativa e outra. Se você usa outro widget de consumo junto, os dois estão chamando o mesmo endereço.
</details>

<details>
<summary>Depuração</summary>

`CLAUDE_DOCK_DEBUG=1 claude-dock` mostra no terminal cada mensagem entre a página e o Python e liga o inspetor do WebKit (botão direito, Inspecionar). Pra mexer na interface num navegador comum, sirva o repositório com `python3 -m http.server` e abra `tools/stage.html?lang=pt`. Ele roda o painel com dados de exemplo sobre um desktop falso, e foi assim que os prints deste README foram feitos.
</details>

## Licença

MIT. Faça o que quiser com ele.

Se você gosta de ter o Claude Code à vista, dá uma olhada no [Claude Pet](https://github.com/krugerrgabriel/claude-pet), um robozinho em pixel art que anda pela tela mostrando o que o Claude está fazendo, e no [Claude Sessions Manager](https://github.com/krugerrgabriel/claude-sessions-manager), um painel local pra achar e retomar qualquer conversa antiga.
