# Forca & Companhia

Jogo da forca em português do Brasil com modo solo e salas multiplayer em tempo real. O servidor é a autoridade da partida: ele escolhe as palavras, valida os palpites, aplica as regras e calcula a pontuação. A palavra secreta só é enviada quando a rodada termina.

## Requisitos

- Node.js 20 ou superior
- npm

## Instalação e execução

```powershell
npm install
npm start
```

Abra `http://localhost:3000`. Para jogar com outras pessoas na mesma rede, compartilhe o endereço local do servidor; para acesso pela internet, publique a aplicação atrás de um proxy que encaminhe HTTP e WebSocket (`ws`/`wss`) para a mesma porta.

O servidor Node original salva o placar em `data/scores.json`; a versão Cloudflare mantém o ranking no Durable Object `GameDirectory`. Os dados locais existentes não são migrados automaticamente para a Cloudflare. A variável `PORT` altera a porta do servidor Node (padrão `3000`).

## Publicar na Cloudflare sem instalar Node.js no computador

A versão Cloudflare mantém os arquivos originais do servidor e acrescenta um Worker, Durable Objects e o binding de arquivos estáticos. O Cloudflare Workers Builds instala as dependências e executa o Wrangler nos servidores da Cloudflare; não é necessário instalar Node.js localmente.

1. Envie o projeto para um repositório GitHub. Isso pode ser feito pelo site do GitHub usando **Add file > Upload files**, sem instalar programas.
2. No painel Cloudflare, abra **Workers & Pages > Create application > GitHub**, autorize o acesso e selecione o repositório.
3. Configure a raiz do projeto como `/` e confira que o nome do Worker é `forca-brasileira`, igual ao campo `name` em `wrangler.jsonc`.
4. Use `npm run deploy:cloudflare` como comando de publicação. Não é necessário um comando de build separado; Wrangler empacota o Worker, os Durable Objects e `public/`.
5. Se habilitar pré-visualizações de branches, mantenha o comando padrão `npx wrangler preview`. Acompanhe o resultado e a URL `workers.dev` na aba **Deployments**.

O arquivo `wrangler.jsonc` configura os assets e as migrações SQLite dos Durable Objects. A primeira publicação cria as classes `PlayerSession`, `GameRoom` e `GameDirectory`. O cliente continua usando o WebSocket da mesma origem, e o estado de salas e ranking fica no servidor Cloudflare. O modo Node e os seus testes continuam disponíveis separadamente.

## Como jogar

- **Solo:** escolha apelido, categoria e dificuldade; descubra a palavra com até seis erros.
- **Multiplayer:** crie uma sala privada (o código pode ser copiado) ou pública, compartilhe o código ou entre por uma sala aberta. São aceitos de 2 a 8 participantes.
- **Formatos:** em “todos contra a palavra”, qualquer jogador pode palpitar e quem completar a palavra primeiro recebe os pontos; em “competição por turnos”, somente o jogador da vez pode palpitar.
- O anfitrião configura categoria, dificuldade, formato, limite de jogadores, rodadas, cronômetro, dicas e pontuação. Também pode pausar, retomar ou encerrar a partida.
- Acentos são ignorados por padrão. Palavras usadas não se repetem na mesma partida até que o conjunto elegível seja esgotado.
- Uma conexão multiplayer interrompida pode ser retomada pelo mesmo navegador durante 60 segundos. Depois desse período, o participante inativo é removido.
- O ranking agrega partidas finalizadas por apelido; ele fica no arquivo local com Node ou no Durable Object `GameDirectory` na Cloudflare.

## Testes

```powershell
npm test
```

Os testes verificam o total, unicidade e categorias das 1.000 palavras, a normalização de acentos, o limite de erros, a ausência de repetição e o fluxo multiplayer completo entre dois clientes (incluindo segredo, palpites duplicados, sincronização, pontuação e rodada seguinte).

Para validar as classes Cloudflare no runtime Workers, execute `npm run test:cloudflare`. Esse conjunto verifica o bundle do banco, health check, segredo da palavra, ações em sala, pontuação e rodada seguinte; requer Node/npm para execução local, mas o código também pode ser validado em CI ou em ambiente remoto.

## Banco de palavras

O arquivo `wordbank.js` contém dez categorias com cem entradas únicas por categoria. O servidor valida o total e a unicidade ao iniciar; uma lista inválida impede a inicialização em vez de reduzir silenciosamente o banco.
