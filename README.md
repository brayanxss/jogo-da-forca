# Forca & Companhia

Jogo da forca em português do Brasil, com modo solo e multiplayer. O projeto mantém a aplicação Node.js original e inclui uma implantação Cloudflare baseada em Workers, Durable Objects, WebSockets e D1. As partidas competitivas são validadas no servidor; a palavra secreta não é enviada a um jogador antes de ele concluir sua rodada.

## Requisitos

- Node.js 20 ou superior e npm para desenvolvimento/testes locais.
- Uma conta Cloudflare com Workers e D1 habilitados para publicação.
- Uma conta GitHub para conectar o repositório ao Cloudflare Workers Builds.

Não é necessário instalar Node.js no computador para publicar pelo Workers Builds: o build e o deploy são executados na infraestrutura Cloudflare.

## Aplicação original com Node.js

```powershell
npm install
npm start
```

Abra `http://localhost:3000`. A variável `PORT` altera a porta (padrão `3000`). Para jogar com outras pessoas pela internet nessa versão, o proxy deve encaminhar HTTP e WebSocket (`ws`/`wss`) para o servidor.

Os arquivos `server.js`, `wordbank.js` e `tests/game.test.js` continuam sendo a implementação original. O placar dessa versão usa `data/scores.json`; ele não é migrado automaticamente para D1.

## Multiplayer Cloudflare

### O que é implantado

- O Worker entrega os arquivos de `public/`, recebe WebSockets e responde ao health check em `/health`.
- Cada sala tem um Durable Object `GameRoom` independente. `PlayerSession` mantém as conexões WebSocket individuais; `GameDirectory` mantém o índice de salas e grava os resultados no D1.
- Todos participam simultaneamente da rodada, cada um com seus próprios palpites e erros. A palavra é escolhida e mantida no Durable Object da sala.
- São aceitos de 2 a 8 participantes. O padrão é cinco rodadas, 60 segundos por rodada, seis erros, 100 pontos por palavra, 30 de bônus sem erros, 20 por rapidez e 25 a cada terceira vitória consecutiva. O anfitrião pode ajustar as opções disponíveis.
- A classificação resolve empates por pontuação, menos erros, menor tempo acumulado e mais palavras descobertas. O ranking geral e semanal usa D1; resultados são identificados por partida e apelido para evitar contabilização duplicada.
- O estado da sala é persistido no Durable Object. Alarmes controlam os prazos das rodadas, a expiração de salas reservadas e o período de reconexão de 60 segundos. O chat e as reações têm limites de frequência.

O formato competitivo Cloudflare é simultâneo (“todos contra a palavra”). A versão Node original permanece separada e não é substituída.

### Criar o D1

O manifesto `wrangler.jsonc` precisa do UUID do banco criado na sua conta. Crie um D1 no painel Cloudflare, em **Storage & databases > D1 > Create database**, usando o nome `forca-brasileira-ranking`. Copie o UUID exibido e substitua o valor de exemplo `00000000-0000-0000-0000-000000000000` em `wrangler.jsonc`, no campo `database_id`.

Esse UUID identifica o banco, mas não é uma senha ou token. Não coloque tokens de API, senhas ou credenciais no repositório.

### Publicar conectando o GitHub

1. Envie o projeto ao GitHub, incluindo `cloudflare/`, `public/`, `wordbank.js`, `wrangler.jsonc`, `package.json` e os testes. O `.gitignore` exclui dependências, arquivos de ambiente e dados locais, sem ignorar os arquivos de publicação.
2. No painel Cloudflare, abra **Workers & Pages > Create application > GitHub** e selecione o repositório. O nome do Worker precisa ser `forca-brasileira`, como no `wrangler.jsonc`.
3. Configure a raiz como `/`, o comando de build como `npm run build` e o comando de deploy como `npm run deploy:cloudflare`.
4. Confirme que o binding D1 `DB` e os bindings Durable Objects do `wrangler.jsonc` estão incluídos na publicação. O Wrangler usa o manifesto como configuração.
5. Acompanhe o deploy e abra a URL `workers.dev` apresentada pelo painel. A rota `/health` deve informar `ok: true` e `words: 1000`.

O comando de deploy aplica primeiro as migrations remotas de `cloudflare/migrations/` e, se isso terminar sem erro, publica o Worker. A primeira implantação também cria as classes Durable Objects declaradas em `wrangler.jsonc`.
O Workers Builds gerencia a autenticação de deploy pela Cloudflare; não salve tokens ou credenciais no repositório nem em arquivos versionados.

### Atualizar Production

Envie as alterações para a branch de produção conectada ao Workers Builds. O pipeline executa o build, aplica migrations D1 pendentes e publica o Worker. Confira o resultado do deploy antes de usar **Rollback** ou promover outra versão. Se você alterar o UUID do D1, confirme cuidadosamente que está apontando para o banco correto: migrations não transferem automaticamente os dados de um banco antigo.

É possível também executar os comandos em um ambiente com Node.js e acesso à conta Cloudflare:

```powershell
npm install
npm run deploy:cloudflare
```

Para desenvolver com o D1 local:

```powershell
npm run migrate:cloudflare:local
npm run dev:cloudflare
```

## Regras do jogo

- **Solo:** mantém o fluxo solo disponível no cliente e valida palpites e pontuação no servidor.
- **Multiplayer:** salas públicas ou privadas, código de convite, lista de salas públicas, anfitrião, prontidão, configurações de sala e até oito jogadores.
- Cada jogador tem seu próprio progresso, tentativas e resultado. O primeiro a acertar é identificado; as letras de outro jogador não alteram seu teclado nem sua rodada.
- A partida começa com no mínimo dois jogadores prontos. Novas entradas durante a partida são controladas pela configuração da sala.
- Acentos são ignorados por padrão, com opção de considerá-los separadamente. Palavras não se repetem na mesma partida até que o conjunto elegível se esgote.
- Dicas, categoria, dificuldade, duração e número de rodadas são controlados pelas opções da sala.
- Uma desconexão multiplayer pode ser retomada pela mesma sessão/navegador por até 60 segundos. Depois do prazo, o jogador inativo é removido da lista da sala.
- Chat, reações e avisos de entrada, saída, vitórias e campeão são enviados em tempo real.

O arquivo `wordbank.js` mantém as 1.000 palavras únicas e as dez categorias utilizadas por ambas as versões.

## Testes

Testes da aplicação Node:

```powershell
npm test
```

Testes no runtime Cloudflare Workers, com Vitest e o plugin oficial:

```powershell
npm run test:cloudflare
```

Os testes Cloudflare cobrem o banco de palavras, salas independentes, oito jogadores, sincronização WebSocket com progresso individual, pontuação e desempates, reconexão/expiração, alarmes, segredo da palavra e persistência/idempotência do ranking D1. O runner usa um worker e armazenamento compartilhado para permitir testes com WebSockets. O workflow do GitHub executa ambos os conjuntos em pushes e pull requests.

## Arquivos principais

- `cloudflare/worker.js`: roteamento do Worker e bindings.
- `cloudflare/room.js`: estado, regras e pontuação autoritativos de cada sala.
- `cloudflare/session.js`: WebSocket, sessões e modo solo.
- `cloudflare/directory.js`: diretório de salas e integração de resultados/ranking D1.
- `cloudflare/migrations/0001_ranking.sql`: schema do ranking e histórico por partida.
- `cloudflare/tests/`: testes no ambiente Cloudflare.
- `wrangler.jsonc`: configuração de publicação, Durable Objects, assets e D1.
