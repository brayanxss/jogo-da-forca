import {
  CATEGORIES,
  WORDS,
  cleanName,
  directoryStub,
  jsonResponse,
  normalizeLetter,
  postJson,
  randomItem,
  roomStub
} from "./shared.js";
import { getRanking } from "./directory.js";

const MAX_MESSAGE_LENGTH = 4096;

export class PlayerSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
  }

  get sessionId() {
    return this.ctx.id.toString();
  }

  serialize(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch((error) => {
      console.error("Erro ao processar a sessão:", error);
    });
    return result;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/_deliver" && request.method === "POST") {
      const message = await request.json();
      this.sendToSockets(message);
      return jsonResponse({ ok: true });
    }
    if (url.pathname === "/_close" && request.method === "POST") {
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.close(4001, "Sessão retomada em outra conexão");
        } catch (error) {
          console.error("Não foi possível encerrar uma sessão substituída:", error);
        }
      }
      return jsonResponse({ ok: true });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "Expected a WebSocket upgrade" }, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sessionId: this.sessionId, context: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    return this.serialize(async () => {
      const content = typeof message === "string" ? message : new TextDecoder().decode(message);
      if (content.length > MAX_MESSAGE_LENGTH) {
        socket.close(1009, "Mensagem muito grande");
        return;
      }
      let data;
      try {
        data = JSON.parse(content);
      } catch {
        return this.send(socket, { type: "error", message: "Mensagem inválida." });
      }
      if (!data || typeof data.type !== "string") {
        return this.send(socket, { type: "error", message: "Ação inválida." });
      }
      try {
        await this.dispatch(socket, data);
      } catch (error) {
        console.error(`Falha na ação ${data.type}:`, error);
        this.send(socket, { type: "error", message: "Não foi possível concluir a ação. Tente novamente." });
      }
    });
  }

  async dispatch(socket, data) {
    const attachment = socket.deserializeAttachment() || { sessionId: this.sessionId, context: null };
    if (data.type === "ranking") {
      return this.send(socket, await getRanking(this.env.DB, data.period));
    }
    if (data.type === "public-rooms") {
      const directory = await directoryStub(this.env);
      const response = await postJson(directory, "/_public-rooms", {});
      return this.send(socket, await response.json());
    }
    if (data.type === "create-room") return this.createRoom(socket, data, attachment);
    if (data.type === "join-room") return this.joinRoom(socket, data, attachment);
    if (data.type === "resume-room") return this.resumeRoom(socket, data, attachment);
    if (data.type === "solo-start") return this.startSolo(socket, data, attachment);

    if (data.type === "leave-solo") {
      if (attachment.context?.type !== "solo") {
        return this.send(socket, { type: "error", message: "Não há uma partida solo para sair." });
      }
      await this.ctx.storage.delete("solo");
      socket.serializeAttachment({ sessionId: this.sessionId, context: null });
      return;
    }

    if (data.type === "leave-room") return this.forwardRoomAction(socket, attachment, data);
    if (["guess", "hint", "start-game", "next-round", "update-settings", "pause-game", "resume-game", "end-game",
      "ready-toggle", "chat", "reaction"].includes(data.type)) {
      if (data.type === "guess" && attachment.context?.type === "solo") {
        return this.guessSolo(socket, data, attachment);
      }
      if (data.type === "hint" && attachment.context?.type === "solo") {
        return this.hintSolo(socket, attachment);
      }
      return this.forwardRoomAction(socket, attachment, data);
    }
    this.send(socket, { type: "error", message: "Ação desconhecida." });
  }

  async createRoom(socket, data, attachment) {
    if (attachment.context) return this.send(socket, { type: "error", message: "Saia da partida atual antes de criar outra sala." });
    const name = cleanName(data.name);
    if (!name) return this.send(socket, { type: "error", message: "Informe um apelido de 1 a 20 caracteres." });
    const directory = await directoryStub(this.env);
    const allocation = await postJson(directory, "/_allocate", {});
    const { code } = await allocation.json();
    const room = await roomStub(this.env, code);
    const response = await postJson(room, "/_create", {
      code,
      sessionId: this.sessionId,
      name,
      settings: data.settings || {}
    });
    const result = await response.json();
    if (!response.ok) {
      await postJson(directory, "/_release", { code });
      return this.send(socket, { type: "error", message: result.error || "Não foi possível criar a sala." });
    }
    socket.serializeAttachment({ sessionId: this.sessionId, context: { type: "room", code, playerId: result.playerId, token: result.token } });
    this.send(socket, result);
  }

  async joinRoom(socket, data, attachment) {
    if (attachment.context) return this.send(socket, { type: "error", message: "Saia da partida atual antes de entrar em outra sala." });
    const code = typeof data.code === "string" ? data.code.trim().toUpperCase() : "";
    const name = cleanName(data.name);
    if (!name) return this.send(socket, { type: "error", message: "Informe um apelido de 1 a 20 caracteres." });
    if (!/^[A-F0-9]{6}$/.test(code)) return this.send(socket, { type: "error", message: "Sala não encontrada. Confira o código." });
    const room = await roomStub(this.env, code);
    const response = await postJson(room, "/_join", { code, sessionId: this.sessionId, name });
    const result = await response.json();
    if (!response.ok) return this.send(socket, { type: "error", message: result.error || "Não foi possível entrar na sala." });
    socket.serializeAttachment({ sessionId: this.sessionId, context: { type: "room", code, playerId: result.playerId, token: result.token } });
    this.send(socket, result);
  }

  async resumeRoom(socket, data, attachment) {
    if (attachment.context) return this.send(socket, { type: "error", message: "Saia da partida atual antes de retomar outra sessão." });
    const code = typeof data.code === "string" ? data.code.trim().toUpperCase() : "";
    if (!/^[A-F0-9]{6}$/.test(code) || typeof data.token !== "string") {
      return this.send(socket, { type: "error", message: "Não foi possível retomar essa sessão." });
    }
    const room = await roomStub(this.env, code);
    const response = await postJson(room, "/_resume", {
      code,
      token: data.token,
      sessionId: this.sessionId
    });
    const result = await response.json();
    if (!response.ok) return this.send(socket, { type: "error", message: result.error || "Não foi possível retomar essa sessão." });
    socket.serializeAttachment({ sessionId: this.sessionId, context: { type: "room", code, playerId: result.playerId, token: result.token } });
    this.send(socket, result);
  }

  async startSolo(socket, data, attachment) {
    if (attachment.context?.type === "room") {
      return this.send(socket, { type: "error", message: "Saia da sala atual antes de iniciar uma partida solo." });
    }
    const name = cleanName(data.name);
    if (!name) return this.send(socket, { type: "error", message: "Informe um apelido de 1 a 20 caracteres." });
    if (data.difficulty && !["facil", "medio", "dificil"].includes(data.difficulty)) {
      return this.send(socket, { type: "error", message: "Dificuldade inválida." });
    }
    if (data.category && !CATEGORIES.includes(data.category)) {
      return this.send(socket, { type: "error", message: "Categoria inválida." });
    }
    const eligible = WORDS.filter((entry) =>
      (!data.category || entry.category === data.category) &&
      (!data.difficulty || entry.difficulty === data.difficulty)
    );
    if (!eligible.length) return this.send(socket, { type: "error", message: "Não há palavras para essa combinação." });
    const game = {
      id: crypto.randomUUID(),
      name,
      word: randomItem(eligible),
      guessed: [],
      mistakes: 0,
      status: "playing",
      startedAt: Date.now(),
      hintUsed: false,
      ignoreAccents: data.ignoreAccents !== false,
      timeLimit: 0,
      roundNumber: 1
    };
    await this.ctx.storage.put("solo", game);
    socket.serializeAttachment({ sessionId: this.sessionId, context: { type: "solo", gameId: game.id, name } });
    this.send(socket, {
      type: "solo-state",
      game: this.publicSoloRound(game, normalizeLetter),
      gameId: game.id,
      points: 0
    });
  }

  async guessSolo(socket, data, attachment) {
    const game = await this.ctx.storage.get("solo");
    if (!game || game.id !== attachment.context?.gameId) {
      return this.send(socket, { type: "error", message: "Essa partida solo não está mais disponível." });
    }
    if (game.status !== "playing") return this.send(socket, { type: "error", message: "Essa rodada já terminou." });
    const { normalizeLetter, WORDS, randomItem } = await import("./shared.js");
    const letter = normalizeLetter(data.letter, game.ignoreAccents);
    if (!letter) return this.send(socket, { type: "error", message: "Escolha uma letra válida." });
    if (game.guessed.includes(letter)) return this.send(socket, { type: "error", message: "Essa letra já foi escolhida." });
    game.guessed.push(letter);
    if (![...game.word.word].some((char) => /\p{L}/u.test(char) && normalizeLetter(char, game.ignoreAccents) === letter)) game.mistakes += 1;
    const solved = [...game.word.word].every((char) =>
      !/\p{L}/u.test(char) || game.guessed.includes(normalizeLetter(char, game.ignoreAccents))
    );
    let points = 0;
    if (solved || game.mistakes >= 6) {
      game.status = solved ? "won" : "lost";
      const elapsed = (Date.now() - game.startedAt) / 1000;
      points = solved ? 100 + (game.mistakes === 0 ? 20 : 0) + (elapsed <= 30 ? 10 : 0) : 0;
      const directory = await this.directory();
      const record = await postJson(directory, "/_record", {
        gameId: game.id,
        name: game.name,
        outcome: game.status,
        points,
        duration: elapsed,
        errors: game.mistakes
      });
      if (!record.ok) throw new Error("Não foi possível registrar a pontuação solo.");
    }
    await this.ctx.storage.put("solo", game);
    this.send(socket, { type: "solo-state", game: this.publicSoloRound(game, normalizeLetter), gameId: game.id, points });
  }

  async hintSolo(socket, attachment) {
    const game = await this.ctx.storage.get("solo");
    if (!game || game.id !== attachment.context?.gameId || game.status !== "playing" || game.hintUsed) {
      return this.send(socket, { type: "error", message: "A dica não está disponível." });
    }
    game.hintUsed = true;
    await this.ctx.storage.put("solo", game);
    const { normalizeLetter } = await import("./shared.js");
    this.send(socket, { type: "solo-state", game: this.publicSoloRound(game, normalizeLetter), gameId: game.id });
  }

  async forwardRoomAction(socket, attachment, data) {
    const context = attachment.context;
    if (context?.type !== "room") {
      return this.send(socket, { type: "error", message: "Entre em uma partida primeiro." });
    }
    const room = await roomStub(this.env, context.code);
    const response = await postJson(room, "/_action", {
      ...data,
      sessionId: this.sessionId,
      playerId: context.playerId
    });
    const result = await response.json();
    if (!response.ok) return this.send(socket, { type: "error", message: result.error || "Não foi possível concluir a ação." });
    if (data.type === "leave-room") socket.serializeAttachment({ sessionId: this.sessionId, context: null });
    if (result.type === "left") return;
    if (result.type && result.type !== "state" && result.type !== "left") this.send(socket, result);
  }

  async directory() {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("global"));
  }

  publicSoloRound(game, normalize) {
    return {
      masked: [...game.word.word].map((letter) =>
        !/\p{L}/u.test(letter) ? letter : (game.guessed.includes(normalize(letter, game.ignoreAccents)) ? letter : "")
      ),
      guessed: game.guessed,
      mistakes: game.mistakes,
      maxErrors: 6,
      status: game.status,
      hint: game.hintUsed ? game.word.hint : null,
      category: game.word.category,
      roundNumber: game.roundNumber,
      winnerId: null,
      answer: game.status === "won" || game.status === "lost" ? game.word.word : null,
      startedAt: game.startedAt,
      timeLimit: 0,
      ignoreAccents: game.ignoreAccents
    };
  }

  send(socket, message) {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(message));
    }
  }

  sendToSockets(message) {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, message);
  }

  webSocketClose(socket) {
    return this.serialize(async () => {
      const attachment = socket.deserializeAttachment();
      if (attachment?.context?.type === "room") {
        const room = await roomStub(this.env, attachment.context.code);
        await postJson(room, "/_disconnect", {
          playerId: attachment.context.playerId,
          sessionId: this.sessionId
        });
      } else if (attachment?.context?.type === "solo") {
        await this.ctx.storage.delete("solo");
      }
    });
  }

  webSocketError(socket, error) {
    console.error("Erro no WebSocket da sessão:", error);
    return this.webSocketClose(socket);
  }
}
