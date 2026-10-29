import {
  CATEGORIES,
  MAX_ERRORS,
  WORDS,
  cleanName,
  deliverToSession,
  jsonResponse,
  makePlayerToken,
  normalizeLetter,
  postJson,
  randomItem
} from "./shared.js";

const VALID_DIFFICULTIES = new Set(["facil", "medio", "dificil"]);
const VALID_FORMATS = new Set(["all", "turns"]);

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get("room")) || null;
      this.code = this.room?.code || ctx.id.name;
    });
  }

  serialize(operation) {
    const result = this.queue.then(async () => {
      await this.ready;
      return operation();
    });
    this.queue = result.catch((error) => {
      console.error("Erro ao processar o estado da sala:", error);
    });
    return result;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    let data;
    try {
      data = await request.json();
    } catch {
      return jsonResponse({ error: "Mensagem inválida." }, 400);
    }

    return this.serialize(async () => {
      try {
        switch (url.pathname) {
          case "/_create": return await this.create(data);
          case "/_join": return await this.join(data);
          case "/_resume": return await this.resume(data);
          case "/_disconnect": return await this.disconnect(data);
          case "/_action": return await this.action(data);
          default: return jsonResponse({ error: "Unknown room action" }, 404);
        }
      } catch (error) {
        console.error(`Falha na ação de sala ${url.pathname}:`, error);
        return jsonResponse({ error: "Não foi possível concluir a ação. Tente novamente." }, 500);
      }
    });
  }

  async create(data) {
    if (this.room) return jsonResponse({ error: "Essa sala já existe." }, 409);
    const name = cleanName(data.name);
    if (!name) return jsonResponse({ error: "Informe um apelido de 1 a 20 caracteres." }, 400);
    const input = data.settings || {};
    if (input.category && !CATEGORIES.includes(input.category)) return jsonResponse({ error: "Categoria inválida." }, 400);
    if (input.format && !VALID_FORMATS.has(input.format)) return jsonResponse({ error: "Formato de partida inválido." }, 400);
    if (input.difficulty && !VALID_DIFFICULTIES.has(input.difficulty)) return jsonResponse({ error: "Dificuldade inválida." }, 400);
    if (!this.hasWords(input.category || "", input.difficulty || "")) {
      return jsonResponse({ error: "Não há palavras para essa categoria e dificuldade." }, 400);
    }

    const id = crypto.randomUUID();
    const player = {
      id,
      name,
      points: 0,
      wordsFound: 0,
      errors: 0,
      sessionId: data.sessionId,
      token: makePlayerToken(),
      connected: true,
      disconnectedAt: null
    };
    this.room = {
      code: data.code,
      hostId: id,
      status: "lobby",
      roundNumber: 0,
      usedWords: [],
      players: [player],
      settings: this.cleanSettings(input, 1)
    };
    this.code = data.code;
    await this.persist();
    await this.updateDirectory();
    return jsonResponse(this.joined(player));
  }

  async join(data) {
    const room = this.room;
    const name = cleanName(data.name);
    if (!room || room.code !== data.code) return jsonResponse({ error: "Sala não encontrada. Confira o código." }, 404);
    if (!name) return jsonResponse({ error: "Informe um apelido de 1 a 20 caracteres." }, 400);
    if (room.status !== "lobby") return jsonResponse({ error: "A partida já começou." }, 409);
    if (room.players.length >= room.settings.maxPlayers) return jsonResponse({ error: "A sala está cheia." }, 409);
    if (room.players.some((player) => player.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
      return jsonResponse({ error: "Esse apelido já está em uso na sala." }, 409);
    }
    const player = {
      id: crypto.randomUUID(),
      name,
      points: 0,
      wordsFound: 0,
      errors: 0,
      sessionId: data.sessionId,
      token: makePlayerToken(),
      connected: true,
      disconnectedAt: null
    };
    room.players.push(player);
    await this.persist();
    await this.updateDirectory();
    await this.broadcast();
    return jsonResponse(this.joined(player));
  }

  async resume(data) {
    const room = this.room;
    const player = room?.code === data.code ? room.players.find((entry) => entry.token === data.token) : null;
    if (!player) return jsonResponse({ error: "Não foi possível retomar essa sessão." }, 404);
    const previousSession = player.sessionId;
    player.sessionId = data.sessionId;
    player.connected = true;
    player.disconnectedAt = null;
    await this.persist();
    await this.syncAlarm();
    if (previousSession && previousSession !== data.sessionId) {
      await this.sendClose(previousSession);
    }
    await this.broadcast();
    return jsonResponse(this.joined(player));
  }

  async disconnect(data) {
    const room = this.room;
    const player = room?.players.find((entry) => entry.id === data.playerId);
    if (!player || player.sessionId !== data.sessionId) return jsonResponse({ ok: true });
    player.connected = false;
    player.disconnectedAt = Date.now();
    await this.persist();
    await this.syncAlarm();
    await this.broadcast();
    return jsonResponse({ ok: true });
  }

  async action(data) {
    const room = this.room;
    const player = room?.players.find((entry) => entry.id === data.playerId);
    if (!room || !player || player.sessionId !== data.sessionId) {
      return jsonResponse({ error: "Entre em uma partida primeiro." }, 403);
    }

    if (data.type === "leave-room") return this.leave(player);
    if (data.type === "guess") return this.guess(player, data.letter);
    if (data.type === "hint") return this.hint();

    if (!["start-game", "next-round", "update-settings", "pause-game", "resume-game", "end-game"].includes(data.type)) {
      return jsonResponse({ error: "Ação desconhecida." }, 400);
    }
    if (player.id !== room.hostId) return jsonResponse({ error: "Somente o anfitrião pode controlar a sala." }, 403);

    if (data.type === "update-settings") return this.updateSettings(data.settings || {});
    if (data.type === "start-game") return this.startGame();
    if (data.type === "next-round") {
      if (!room.round || room.round.status === "playing") return jsonResponse({ error: "A rodada atual ainda está em andamento." }, 409);
      await this.startRound();
      return jsonResponse({ ok: true });
    }
    if (data.type === "pause-game") return this.pause();
    if (data.type === "resume-game") return this.resumeGame();
    return this.endGame();
  }

  async updateSettings(input) {
    const room = this.room;
    if (room.status !== "lobby") return jsonResponse({ error: "As opções não podem ser alteradas durante a partida." }, 409);
    if (input.category && !CATEGORIES.includes(input.category)) return jsonResponse({ error: "Categoria inválida." }, 400);
    if (input.difficulty && !VALID_DIFFICULTIES.has(input.difficulty)) return jsonResponse({ error: "Dificuldade inválida." }, 400);
    if (input.format && !VALID_FORMATS.has(input.format)) return jsonResponse({ error: "Formato de partida inválido." }, 400);
    if (!this.hasWords(input.category || "", input.difficulty || "")) {
      return jsonResponse({ error: "Não há palavras para essa categoria e dificuldade." }, 400);
    }
    room.settings = this.cleanSettings(input, room.players.length, room.settings);
    await this.persist();
    await this.updateDirectory();
    await this.broadcast();
    return jsonResponse({ ok: true });
  }

  cleanSettings(input, playerCount, previous = {}) {
    const maxPlayersInput = Number(input.maxPlayers) || previous.maxPlayers || 8;
    const points = (key, fallback, maximum) => {
      const value = Number(input[key]);
      return Number.isFinite(value) ? Math.min(maximum, Math.max(0, value)) : (previous[key] ?? fallback);
    };
    return {
      maxPlayers: Math.min(8, Math.max(2, playerCount, maxPlayersInput)),
      category: input.category || previous.category || "",
      difficulty: VALID_DIFFICULTIES.has(input.difficulty) ? input.difficulty : (previous.difficulty || ""),
      timeLimit: Math.min(300, Math.max(0, Number(input.timeLimit) || 0)),
      rounds: Math.min(50, Math.max(1, Number(input.rounds) || previous.rounds || 10)),
      hints: input.hints === undefined ? (previous.hints ?? true) : input.hints === true,
      speedBonus: points("speedBonus", 10, 1000),
      speedEnabled: input.speedEnabled === undefined ? (previous.speedEnabled ?? true) : input.speedEnabled === true,
      speedThreshold: Math.min(600, Math.max(5, Number(input.speedThreshold) || previous.speedThreshold || 30)),
      pointsPerWord: points("pointsPerWord", 100, 10000),
      perfectBonus: points("perfectBonus", 20, 10000),
      errorPenalty: points("errorPenalty", 0, 10000),
      ignoreAccents: input.ignoreAccents === undefined ? (previous.ignoreAccents ?? true) : input.ignoreAccents === true,
      format: VALID_FORMATS.has(input.format) ? input.format : (previous.format || "all"),
      isPublic: input.isPublic === undefined ? (previous.isPublic ?? false) : input.isPublic === true
    };
  }

  async startGame() {
    const room = this.room;
    if (room.status !== "lobby" || room.players.length < 2) {
      return jsonResponse({ error: "A sala precisa de pelo menos 2 jogadores." }, 409);
    }
    for (const player of room.players) {
      player.points = 0;
      player.wordsFound = 0;
      player.errors = 0;
    }
    room.roundNumber = 0;
    room.usedWords = [];
    await this.startRound();
    return jsonResponse({ ok: true });
  }

  async startRound() {
    const room = this.room;
    if (room.roundNumber >= room.settings.rounds) {
      room.status = "finished";
      room.round = null;
      await this.persist();
      await this.updateDirectory();
      await this.broadcast("game-finished");
      return;
    }

    const eligible = this.eligibleWords();
    const usedWords = new Set(room.usedWords);
    let pool = eligible.filter((entry) => !usedWords.has(entry.word));
    if (!pool.length) {
      room.usedWords = [];
      pool = eligible;
    }
    const word = randomItem(pool);
    room.usedWords.push(word.word);
    room.roundNumber += 1;
    const now = Date.now();
    room.round = {
      word,
      guessed: [],
      mistakes: 0,
      status: "playing",
      hintUsed: false,
      ignoreAccents: room.settings.ignoreAccents,
      roundNumber: room.roundNumber,
      startedAt: now,
      segmentStartedAt: now,
      elapsedBeforePause: 0,
      pausedAt: null,
      timeLimit: room.settings.timeLimit,
      remainingMs: room.settings.timeLimit * 1000,
      deadline: room.settings.timeLimit ? now + room.settings.timeLimit * 1000 : null,
      winnerId: null,
      endReason: null,
      turnIndex: 0,
      playerErrors: {},
      playerStartPoints: Object.fromEntries(room.players.map((player) => [player.id, player.points]))
    };
    room.status = "playing";
    await this.persist();
    await this.syncAlarm();
    await this.updateDirectory();
    await this.broadcast();
  }

  async guess(player, value) {
    const room = this.room;
    const round = room.round;
    if (!round || room.status !== "playing" || round.status !== "playing") {
      return jsonResponse({ error: "Não há uma rodada em andamento." }, 409);
    }
    if (room.settings.format === "turns" && room.players[round.turnIndex]?.id !== player.id) {
      return jsonResponse({ error: "Aguarde sua vez." }, 403);
    }
    const letter = normalizeLetter(value, round.ignoreAccents);
    if (!letter) return jsonResponse({ error: "Escolha uma letra válida." }, 400);
    if (round.guessed.includes(letter)) return jsonResponse({ error: "Essa letra já foi escolhida." }, 409);
    round.guessed.push(letter);
    const correct = [...round.word.word].some((char) =>
      /\p{L}/u.test(char) && normalizeLetter(char, round.ignoreAccents) === letter
    );
    if (!correct) {
      round.mistakes += 1;
      round.playerErrors[player.id] = (round.playerErrors[player.id] || 0) + 1;
      if (room.settings.errorPenalty) player.points = Math.max(0, player.points - room.settings.errorPenalty);
    }
    const solved = [...round.word.word].every((char) =>
      !/\p{L}/u.test(char) || round.guessed.includes(normalizeLetter(char, round.ignoreAccents))
    );
    if (solved) {
      await this.completeRound("won", player);
      return jsonResponse({ ok: true });
    }
    if (round.mistakes >= MAX_ERRORS) {
      await this.completeRound("lost", null);
      return jsonResponse({ ok: true });
    }
    if (room.settings.format === "turns") {
      round.turnIndex = (room.players.findIndex((entry) => entry.id === player.id) + 1) % room.players.length;
    }
    await this.persist();
    await this.broadcast();
    return jsonResponse({ ok: true });
  }

  async hint() {
    const room = this.room;
    const round = room.round;
    if (!room.settings.hints) return jsonResponse({ error: "As dicas estão desativadas nesta sala." }, 403);
    if (room.status !== "playing") return jsonResponse({ error: "As dicas ficam indisponíveis enquanto a partida está pausada." }, 409);
    if (!round || round.status !== "playing" || round.hintUsed) return jsonResponse({ error: "A dica não está disponível." }, 409);
    round.hintUsed = true;
    await this.persist();
    await this.broadcast();
    return jsonResponse({ ok: true });
  }

  async completeRound(status, winner, reason = status) {
    const room = this.room;
    const round = room.round;
    if (!round || round.status !== "playing") return;
    const now = Date.now();
    round.status = status;
    round.endReason = reason;
    round.winnerId = winner?.id || null;
    round.deadline = null;
    round.pausedAt = now;
    round.remainingMs = 0;
    if (status === "won" && winner) {
      const elapsed = (round.elapsedBeforePause + now - round.segmentStartedAt) / 1000;
      let points = room.settings.pointsPerWord;
      if (round.mistakes === 0) points += room.settings.perfectBonus;
      if (room.settings.speedEnabled && room.settings.speedBonus && elapsed <= room.settings.speedThreshold) {
        points += room.settings.speedBonus;
      }
      winner.points += points;
      winner.wordsFound += 1;
    }

    for (const player of room.players) {
      const errors = round.playerErrors[player.id] || 0;
      player.errors += errors;
      if (status === "won" && player.id === winner?.id) {
        const basePoints = room.settings.pointsPerWord +
          (round.mistakes === 0 ? room.settings.perfectBonus : 0) +
          (room.settings.speedEnabled && room.settings.speedBonus &&
            (round.elapsedBeforePause + now - round.segmentStartedAt) / 1000 <= room.settings.speedThreshold
            ? room.settings.speedBonus : 0);
        await this.recordScore(player.name, status, basePoints - errors * room.settings.errorPenalty,
          (round.elapsedBeforePause + now - round.segmentStartedAt) / 1000, errors);
      } else {
        const scoreDelta = player.points - (round.playerStartPoints[player.id] || 0);
        await this.recordScore(player.name, "lost", scoreDelta, 0, errors);
      }
    }
    await this.persist();
    await this.syncAlarm();
    await this.broadcast(status === "won" ? "round-won" : "round-lost");
  }

  async pause() {
    const room = this.room;
    const round = room.round;
    if (room.status !== "playing" || !round || round.status !== "playing") {
      return jsonResponse({ error: "Não há uma partida em andamento." }, 409);
    }
    const now = Date.now();
    if (round.deadline) round.remainingMs = Math.max(0, round.deadline - now);
    round.deadline = null;
    round.pausedAt = now;
    round.elapsedBeforePause += now - round.segmentStartedAt;
    room.status = "paused";
    await this.persist();
    await this.syncAlarm();
    await this.broadcast();
    return jsonResponse({ ok: true });
  }

  async resumeGame() {
    const room = this.room;
    const round = room.round;
    if (room.status !== "paused" || !round || round.status !== "playing") {
      return jsonResponse({ error: "A partida não está pausada." }, 409);
    }
    const now = Date.now();
    round.segmentStartedAt = now;
    round.startedAt += now - round.pausedAt;
    round.pausedAt = null;
    round.deadline = room.settings.timeLimit ? now + round.remainingMs : null;
    room.status = "playing";
    await this.persist();
    await this.syncAlarm();
    await this.broadcast();
    return jsonResponse({ ok: true });
  }

  async endGame() {
    const room = this.room;
    if (room.round?.status === "playing") await this.completeRound("lost", null, "ended");
    room.status = "finished";
    await this.persist();
    await this.updateDirectory();
    await this.broadcast("game-finished");
    return jsonResponse({ ok: true });
  }

  async leave(player) {
    const room = this.room;
    const activeTurnId = room.round && room.settings.format === "turns"
      ? room.players[room.round.turnIndex]?.id
      : null;
    room.players = room.players.filter((entry) => entry.id !== player.id);
    if (!room.players.length) {
      await this.ctx.storage.delete("room");
      if (await this.ctx.storage.getAlarm()) await this.ctx.storage.deleteAlarm();
      this.room = null;
      await this.updateDirectory(true);
      return jsonResponse({ type: "left" });
    }
    this.selectHostAndTurn(activeTurnId);
    await this.persist();
    await this.syncAlarm();
    await this.updateDirectory();
    await this.broadcast();
    return jsonResponse({ type: "left" });
  }

  async alarm() {
    return this.serialize(async () => {
      if (!this.room) return;
      const now = Date.now();
      const activeTurnId = this.room.round && this.room.settings.format === "turns"
        ? this.room.players[this.room.round.turnIndex]?.id
        : null;
      const expiredPlayers = this.room.players.filter((player) =>
        !player.connected && player.disconnectedAt && player.disconnectedAt + 60_000 <= now
      );
      if (expiredPlayers.length) {
        const expiredIds = new Set(expiredPlayers.map((player) => player.id));
        this.room.players = this.room.players.filter((player) => !expiredIds.has(player.id));
        this.selectHostAndTurn(activeTurnId);
      }
      if (this.room.round?.status === "playing" && this.room.round.deadline && this.room.round.deadline <= now) {
        await this.completeRound("lost", null, "timeout");
      } else {
        await this.persist();
        await this.broadcast();
      }
      if (!this.room.players.length) {
        this.room = null;
        await this.ctx.storage.delete("room");
        await this.updateDirectory(true);
      } else {
        await this.syncAlarm();
        await this.updateDirectory();
      }
    });
  }

  selectHostAndTurn(previousTurnId) {
    const room = this.room;
    if (room.players.length && !room.players.some((player) => player.id === room.hostId)) {
      room.hostId = room.players[0].id;
    }
    if (room.round && room.settings.format === "turns" && room.players.length) {
      const currentIndex = room.players.findIndex((player) => player.id === previousTurnId);
      room.round.turnIndex = currentIndex >= 0 ? currentIndex : room.round.turnIndex % room.players.length;
    }
  }

  async persist() {
    if (this.room) await this.ctx.storage.put("room", this.room);
  }

  async syncAlarm() {
    const room = this.room;
    if (!room) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const deadlines = [];
    if (room.round?.status === "playing" && room.round.deadline) deadlines.push(room.round.deadline);
    for (const player of room.players) {
      if (!player.connected && player.disconnectedAt) deadlines.push(player.disconnectedAt + 60_000);
    }
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    else await this.ctx.storage.deleteAlarm();
  }

  async updateDirectory(remove = false) {
    const directory = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("global"));
    const room = this.room;
    const response = await postJson(directory, "/_room", remove ? { code: room?.code || this.code, remove: true } : {
      code: room.code,
      isPublic: room.settings.isPublic,
      status: room.status,
      players: room.players.length,
      maxPlayers: room.settings.maxPlayers,
      category: room.settings.category,
      format: room.settings.format
    });
    if (!response.ok) throw new Error("Não foi possível atualizar o diretório de salas.");
  }

  async broadcast(type = "state") {
    const room = this.room;
    if (!room) return;
    const message = { type, room: this.snapshot() };
    await Promise.all(room.players.map(async (player) => {
      try {
        const response = await deliverToSession(this.env, player.sessionId, message);
        if (!response.ok) console.error(`Falha ao enviar estado ao jogador ${player.id}: ${response.status}`);
      } catch (error) {
        console.error(`Falha ao notificar o jogador ${player.id}:`, error);
      }
    }));
  }

  async notifySession(sessionId, message) {
    try {
      await deliverToSession(this.env, sessionId, message);
    } catch (error) {
      console.error("Não foi possível notificar a sessão substituída:", error);
    }
  }

  async recordScore(name, outcome, points, duration, errors) {
    const directory = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("global"));
    const response = await postJson(directory, "/_record", { name, outcome, points, duration, errors });
    if (!response.ok) throw new Error("Não foi possível registrar a pontuação da partida.");
  }

  async sendClose(sessionId) {
    try {
      const id = this.env.SESSIONS.idFromString(sessionId);
      await postJson(this.env.SESSIONS.get(id), "/_close", {});
    } catch (error) {
      console.error("Não foi possível encerrar uma sessão substituída:", error);
    }
  }

  joined(player) {
    return {
      type: "joined",
      room: this.snapshot(),
      playerId: player.id,
      token: player.token
    };
  }

  hasWords(category, difficulty) {
    return this.eligibleWords(category, difficulty).length > 0;
  }

  eligibleWords(category = this.room?.settings.category || "", difficulty = this.room?.settings.difficulty || "") {
    return WORDS.filter((entry) =>
      (!category || entry.category === category) && (!difficulty || entry.difficulty === difficulty)
    );
  }

  publicRound(round) {
    return {
      masked: [...round.word.word].map((letter) =>
        !/\p{L}/u.test(letter) ? letter :
          (round.guessed.includes(normalizeLetter(letter, round.ignoreAccents)) ? letter : "")
      ),
      guessed: round.guessed,
      mistakes: round.mistakes,
      maxErrors: MAX_ERRORS,
      status: round.status,
      hint: round.hintUsed ? round.word.hint : null,
      category: round.word.category,
      roundNumber: round.roundNumber,
      winnerId: round.winnerId,
      answer: round.status === "won" || round.status === "lost" ? round.word.word : null,
      endReason: round.endReason,
      startedAt: round.startedAt,
      timeLimit: round.timeLimit,
      remainingMs: round.remainingMs
    };
  }

  snapshot() {
    const room = this.room;
    return {
      code: room.code,
      status: room.status,
      format: room.settings.format,
      settings: room.settings,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        points: player.points,
        wordsFound: player.wordsFound,
        errors: player.errors,
        connected: player.connected,
        host: player.id === room.hostId
      })),
      round: room.round ? this.publicRound(room.round) : null,
      turnPlayerId: room.round && room.settings.format === "turns"
        ? room.players[room.round.turnIndex]?.id || null
        : null,
      roundNumber: room.roundNumber,
      roundsTotal: room.settings.rounds
    };
  }
}
