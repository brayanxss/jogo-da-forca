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
const VALID_REACTIONS = new Set(["👏", "🔥", "💡", "😮", "💪"]);
const MAX_CHAT_LENGTH = 200;
const RECONNECT_GRACE_MS = 60_000;

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get("room")) || null;
      this.code = this.room?.code || ctx.id.name;
      if (this.room) this.migrateStoredRoom();
    });
  }

  migrateStoredRoom() {
    const room = this.room;
    room.participants ||= [...room.players];
    room.chat ||= [];
    room.rateLimits ||= {};
    room.rankingRecorded ??= false;
    if (room.status !== "lobby" && !room.gameId) room.gameId = crypto.randomUUID();
    room.players.forEach((player) => {
      player.points ||= 0;
      player.wordsFound ||= 0;
      player.roundsPlayed ||= 0;
      player.wins ||= 0;
      player.errors ||= 0;
      player.timeSpentMs ||= 0;
      player.streak ||= 0;
      player.bestStreak ||= 0;
      player.ready ??= true;
    });
    room.participants.forEach((player) => {
      player.roundsPlayed ||= 0;
      if (room.round?.progress?.[player.id]) {
        room.round.progress[player.id].startedAt ||= room.round.startedAt;
      }
    });
    if (room.settings) room.settings = this.cleanSettings(room.settings, room.players.length, room.settings);
    if (room.round && !room.round.progress) {
      room.round.progress = Object.fromEntries(room.players.map((player) => [player.id, {
        guessed: [...(room.round.guessed || [])],
        mistakes: room.round.playerErrors?.[player.id] ?? room.round.mistakes ?? 0,
        status: room.round.status === "playing" ? "playing" : room.round.status,
        elapsedMs: 0,
        hintUsed: room.round.hintUsed === true,
        endReason: room.round.endReason || null
      }]));
      room.round.firstWinnerId = room.round.winnerId || null;
      if (room.round.status !== "playing") room.round.status = "complete";
    }
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
    if (typeof data.code !== "string" || !/^[A-F0-9]{6}$/.test(data.code)) {
      return jsonResponse({ error: "Código de sala inválido." }, 400);
    }
    const settings = this.cleanSettings(data.settings || {}, 1);
    if (settings.category && !CATEGORIES.includes(settings.category)) {
      return jsonResponse({ error: "Categoria inválida." }, 400);
    }
    if (settings.difficulty && !VALID_DIFFICULTIES.has(settings.difficulty)) {
      return jsonResponse({ error: "Dificuldade inválida." }, 400);
    }
    if (!this.hasWords(settings.category, settings.difficulty)) {
      return jsonResponse({ error: "Não há palavras para essa categoria e dificuldade." }, 400);
    }

    const host = this.makePlayer(name, data.sessionId, true);
    this.room = {
      code: data.code,
      gameId: null,
      hostId: host.id,
      status: "lobby",
      roundNumber: 0,
      usedWords: [],
      players: [host],
      participants: [host],
      settings,
      round: null,
      chat: [],
      rateLimits: {},
      rankingRecorded: false
    };
    this.code = data.code;
    await this.persist();
    await this.updateDirectory();
    return jsonResponse(this.joined(host));
  }

  makePlayer(name, sessionId, ready = false) {
    return {
      id: crypto.randomUUID(),
      name,
      token: makePlayerToken(),
      sessionId,
      points: 0,
      wordsFound: 0,
      roundsPlayed: 0,
      wins: 0,
      errors: 0,
      timeSpentMs: 0,
      streak: 0,
      bestStreak: 0,
      connected: true,
      disconnectedAt: null,
      ready
    };
  }

  async join(data) {
    const room = this.room;
    const name = cleanName(data.name);
    if (!room || room.code !== data.code) return jsonResponse({ error: "Sala não encontrada. Confira o código." }, 404);
    if (!name) return jsonResponse({ error: "Informe um apelido de 1 a 20 caracteres." }, 400);
    if (room.status !== "lobby" && !(room.status === "playing" && room.settings.allowLateJoin)) {
      return jsonResponse({ error: "A partida já começou e não aceita novas entradas." }, 409);
    }
    if (room.players.length >= room.settings.maxPlayers) return jsonResponse({ error: "A sala está cheia." }, 409);
    if (room.players.some((player) => player.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
      return jsonResponse({ error: "Esse apelido já está em uso na sala." }, 409);
    }

    const player = this.makePlayer(name, data.sessionId);
    room.players.push(player);
    room.participants ||= [...room.players.filter((entry) => entry.id !== player.id)];
    room.participants.push(player);
    if (room.round?.status === "playing") {
      room.round.progress[player.id] = this.newProgress(Date.now());
      player.roundsPlayed += 1;
    }
    room.chat.push(this.systemMessage(`${name} entrou na sala.`));
    await this.persist();
    await this.updateDirectory();
    await this.broadcast();
    return jsonResponse(this.joined(player));
  }

  async resume(data) {
    const room = this.room;
    const player = room?.code === data.code
      ? room.players.find((entry) => entry.token === data.token)
      : null;
    if (!player) return jsonResponse({ error: "Não foi possível retomar essa sessão." }, 404);
    if (!player.connected && player.disconnectedAt &&
        player.disconnectedAt + RECONNECT_GRACE_MS <= Date.now()) {
      return jsonResponse({ error: "O prazo para reconexão expirou." }, 410);
    }
    const previousSession = player.sessionId;
    player.sessionId = data.sessionId;
    player.connected = true;
    player.disconnectedAt = null;
    await this.persist();
    await this.syncAlarm();
    if (previousSession && previousSession !== data.sessionId) await this.sendClose(previousSession);
    await this.broadcast();
    return jsonResponse(this.joined(player));
  }

  async disconnect(data) {
    const player = this.room?.players.find((entry) => entry.id === data.playerId);
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
    if (data.type === "hint") return this.hint(player);
    if (data.type === "ready-toggle") return this.setReady(player, data.ready);
    if (data.type === "chat") return this.chatMessage(player, data.message);
    if (data.type === "reaction") return this.reaction(player, data.reaction);

    if (!["start-game", "next-round", "update-settings", "pause-game", "resume-game", "end-game"].includes(data.type)) {
      return jsonResponse({ error: "Ação desconhecida." }, 400);
    }
    if (player.id !== room.hostId) return jsonResponse({ error: "Somente o anfitrião pode controlar a sala." }, 403);

    if (data.type === "update-settings") return this.updateSettings(data.settings || {});
    if (data.type === "start-game") return this.startGame();
    if (data.type === "next-round") {
      if (!room.round || room.round.status !== "complete") {
        return jsonResponse({ error: "A rodada atual ainda está em andamento." }, 409);
      }
      await this.startRound();
      return jsonResponse({ ok: true });
    }
    if (data.type === "pause-game") return this.pause();
    if (data.type === "resume-game") return this.resumeGame();
    return this.endGame();
  }

  async setReady(player, ready) {
    if (this.room.status !== "lobby") return jsonResponse({ error: "A partida já começou." }, 409);
    player.ready = typeof ready === "boolean" ? ready : !player.ready;
    await this.persist();
    await this.broadcast();
    return jsonResponse({ ok: true });
  }

  cleanSettings(input, playerCount, previous = {}) {
    const boundedNumber = (value, fallback, min, max) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
    };
    return {
      maxPlayers: boundedNumber(input.maxPlayers, previous.maxPlayers || 8, Math.max(2, playerCount), 8),
      category: input.category === undefined ? (previous.category || "") : input.category,
      difficulty: input.difficulty === undefined
        ? (previous.difficulty || "")
        : (VALID_DIFFICULTIES.has(input.difficulty) ? input.difficulty : (previous.difficulty || "")),
      timeLimit: boundedNumber(input.timeLimit, previous.timeLimit ?? 60, 0, 300),
      rounds: boundedNumber(input.rounds, previous.rounds || 5, 1, 50),
      hints: input.hints === undefined ? (previous.hints ?? true) : input.hints === true,
      speedBonus: boundedNumber(input.speedBonus, previous.speedBonus ?? 20, 0, 1000),
      speedEnabled: input.speedEnabled === undefined ? (previous.speedEnabled ?? true) : input.speedEnabled === true,
      speedThreshold: boundedNumber(input.speedThreshold, previous.speedThreshold ?? 15, 1, 600),
      pointsPerWord: boundedNumber(input.pointsPerWord, previous.pointsPerWord ?? 100, 0, 10000),
      perfectBonus: boundedNumber(input.perfectBonus, previous.perfectBonus ?? 30, 0, 10000),
      streakBonus: boundedNumber(input.streakBonus, previous.streakBonus ?? 25, 0, 10000),
      errorPenalty: 0,
      ignoreAccents: input.ignoreAccents === undefined ? (previous.ignoreAccents ?? true) : input.ignoreAccents === true,
      format: "all",
      isPublic: input.isPublic === undefined ? (previous.isPublic ?? false) : input.isPublic === true,
      allowLateJoin: input.allowLateJoin === undefined ? (previous.allowLateJoin ?? false) : input.allowLateJoin === true
    };
  }

  async updateSettings(input) {
    const room = this.room;
    if (room.status !== "lobby") return jsonResponse({ error: "As opções não podem ser alteradas durante a partida." }, 409);
    if (input.category && !CATEGORIES.includes(input.category)) return jsonResponse({ error: "Categoria inválida." }, 400);
    if (input.difficulty && !VALID_DIFFICULTIES.has(input.difficulty)) return jsonResponse({ error: "Dificuldade inválida." }, 400);
    const settings = this.cleanSettings(input, room.players.length, room.settings);
    if (!this.hasWords(settings.category, settings.difficulty)) {
      return jsonResponse({ error: "Não há palavras para essa categoria e dificuldade." }, 400);
    }
    room.settings = settings;
    await this.persist();
    await this.updateDirectory();
    await this.broadcast();
    return jsonResponse({ ok: true });
  }

  async startGame() {
    const room = this.room;
    if (room.status !== "lobby" || room.players.length < 2) {
      return jsonResponse({ error: "A sala precisa de pelo menos 2 jogadores." }, 409);
    }
    if (room.players.some((player) => !player.ready)) {
      return jsonResponse({ error: "Todos os jogadores precisam estar prontos." }, 409);
    }
    room.players.forEach((player) => {
      player.points = 0;
      player.wordsFound = 0;
      player.roundsPlayed = 0;
      player.wins = 0;
      player.errors = 0;
      player.timeSpentMs = 0;
      player.streak = 0;
      player.bestStreak = 0;
    });
    room.gameId = crypto.randomUUID();
    room.rankingRecorded = false;
    room.roundNumber = 0;
    room.usedWords = [];
    room.chat = [];
    await this.startRound();
    return jsonResponse({ ok: true });
  }

  newProgress(startedAt = Date.now()) {
    return { guessed: [], mistakes: 0, status: "playing", elapsedMs: 0, startedAt, hintUsed: false, endReason: null };
  }

  async startRound() {
    const room = this.room;
    if (room.roundNumber >= room.settings.rounds) return this.finishGame();

    const eligible = this.eligibleWords(room.settings.category, room.settings.difficulty);
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
    const progress = Object.fromEntries(room.players.map((player) => {
      player.roundsPlayed += 1;
      return [player.id, this.newProgress(now)];
    }));
    room.round = {
      word,
      status: "playing",
      roundNumber: room.roundNumber,
      startedAt: now,
      deadline: room.settings.timeLimit ? now + room.settings.timeLimit * 1000 : null,
      remainingMs: room.settings.timeLimit * 1000,
      pausedAt: null,
      elapsedBeforePause: 0,
      progress,
      firstWinnerId: null,
      completedAt: null,
      endReason: null
    };
    room.status = "playing";
    await this.persist();
    await this.syncAlarm();
    await this.updateDirectory();
    await this.broadcast();
  }

  actionRateLimit(player, key, limit, windowMs) {
    const now = Date.now();
    const room = this.room;
    const buckets = room.rateLimits[player.id] || {};
    const timestamps = (buckets[key] || []).filter((timestamp) => now - timestamp < windowMs);
    if (timestamps.length >= limit) return false;
    timestamps.push(now);
    buckets[key] = timestamps;
    room.rateLimits[player.id] = buckets;
    return true;
  }

  async guess(player, value) {
    const room = this.room;
    const round = room.round;
    const progress = round?.progress[player.id];
    if (!round || room.status !== "playing" || round.status !== "playing" || !progress || progress.status !== "playing") {
      return jsonResponse({ error: "Não há uma tentativa em andamento para você." }, 409);
    }
    if (!this.actionRateLimit(player, "guess", 30, 10_000)) {
      return jsonResponse({ error: "Muitas tentativas em pouco tempo. Aguarde um instante." }, 429);
    }
    const letter = normalizeLetter(value, room.settings.ignoreAccents);
    if (!letter) return jsonResponse({ error: "Escolha uma letra válida." }, 400);
    if (progress.guessed.includes(letter)) return jsonResponse({ error: "Essa letra já foi escolhida." }, 409);
    progress.guessed.push(letter);
    const matches = [...round.word.word].some((char) =>
      /\p{L}/u.test(char) && normalizeLetter(char, room.settings.ignoreAccents) === letter
    );
    if (!matches) progress.mistakes += 1;

    const solved = [...round.word.word].every((char) =>
      !/\p{L}/u.test(char) || progress.guessed.includes(normalizeLetter(char, room.settings.ignoreAccents))
    );
    if (solved) {
      this.completePlayer(player, progress, "won", "solved");
      if (!round.firstWinnerId) round.firstWinnerId = player.id;
    } else if (progress.mistakes >= MAX_ERRORS) {
      this.completePlayer(player, progress, "lost", "errors");
    }

    if (Object.values(round.progress).every((entry) => entry.status !== "playing")) {
      await this.completeRound();
    } else {
      await this.persist();
      await this.broadcast();
    }
    return jsonResponse({ ok: true });
  }

  completePlayer(player, progress, status, reason, completedAt = Date.now()) {
    const round = this.room.round;
    progress.status = status;
    progress.endReason = reason;
    progress.completedAt = completedAt;
    progress.elapsedMs = Math.max(0, completedAt - (progress.startedAt || round.startedAt));
    player.timeSpentMs += progress.elapsedMs;
    player.errors += progress.mistakes;
    if (status !== "won") {
      player.streak = 0;
      return;
    }

    player.wordsFound += 1;
    player.wins += 1;
    player.streak += 1;
    player.bestStreak = Math.max(player.bestStreak, player.streak);
    let earned = this.room.settings.pointsPerWord;
    if (progress.mistakes === 0) earned += this.room.settings.perfectBonus;
    if (this.room.settings.speedEnabled &&
        progress.elapsedMs <= this.room.settings.speedThreshold * 1000) {
      earned += this.room.settings.speedBonus;
    }
    if (player.streak % 3 === 0) earned += this.room.settings.streakBonus;
    player.points += earned;
    progress.pointsEarned = earned;
  }

  async completeRound(reason = "complete") {
    const room = this.room;
    const round = room.round;
    if (!round || round.status !== "playing") return;
    const now = Date.now();
    if (reason === "timeout" || reason === "ended") {
      for (const player of room.players) {
        const progress = round.progress[player.id];
        if (progress?.status === "playing") {
          this.completePlayer(player, progress, "lost", reason, reason === "timeout" ? round.deadline : now);
        }
      }
    }
    round.status = "complete";
    round.completedAt = now;
    round.deadline = null;
    round.remainingMs = 0;
    round.endReason = reason;
    const winners = (room.participants || room.players)
      .filter((player) => round.progress[player.id]?.status === "won")
      .map((player) => player.name);
    room.chat.push(this.systemMessage(winners.length
      ? `${winners.join(", ")} ${winners.length === 1 ? "descobriu" : "descobriram"} a palavra.`
      : "A rodada terminou sem palavras descobertas."));
    room.chat = room.chat.slice(-50);
    await this.persist();
    await this.syncAlarm();
    await this.broadcast(Object.values(round.progress).some((entry) => entry.status === "won") ? "round-won" : "round-lost");
    if (room.roundNumber >= room.settings.rounds) await this.finishGame();
  }

  async hint(player) {
    const room = this.room;
    const progress = room.round?.progress[player.id];
    if (!room.settings.hints) return jsonResponse({ error: "As dicas estão desativadas nesta sala." }, 403);
    if (room.status !== "playing" || room.round?.status !== "playing" || !progress || progress.status !== "playing") {
      return jsonResponse({ error: "A dica não está disponível." }, 409);
    }
    if (progress.hintUsed) return jsonResponse({ error: "Você já usou sua dica nesta rodada." }, 409);
    progress.hintUsed = true;
    await this.persist();
    await this.broadcast();
    return jsonResponse({ ok: true });
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
    if (round.pausedAt) {
      const pausedDuration = now - round.pausedAt;
      round.startedAt += pausedDuration;
      for (const progress of Object.values(round.progress)) {
        if (progress.status === "playing") progress.startedAt += pausedDuration;
      }
    }
    round.pausedAt = null;
    round.deadline = room.settings.timeLimit ? now + round.remainingMs : null;
    room.status = "playing";
    await this.persist();
    await this.syncAlarm();
    await this.broadcast();
    return jsonResponse({ ok: true });
  }

  async chatMessage(player, value) {
    const message = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
    if (!message || message.length > MAX_CHAT_LENGTH) {
      return jsonResponse({ error: `A mensagem deve ter de 1 a ${MAX_CHAT_LENGTH} caracteres.` }, 400);
    }
    if (!this.actionRateLimit(player, "chat", 5, 10_000)) {
      return jsonResponse({ error: "Você está enviando mensagens rápido demais." }, 429);
    }
    this.room.chat.push({ id: crypto.randomUUID(), playerId: player.id, name: player.name, message, at: Date.now(), kind: "chat" });
    this.room.chat = this.room.chat.slice(-50);
    await this.persist();
    await this.broadcastEvent({ type: "chat-message", entry: this.room.chat.at(-1) });
    return jsonResponse({ ok: true });
  }

  async reaction(player, value) {
    if (!VALID_REACTIONS.has(value)) return jsonResponse({ error: "Reação inválida." }, 400);
    if (!this.actionRateLimit(player, "reaction", 8, 10_000)) {
      return jsonResponse({ error: "Aguarde antes de enviar outra reação." }, 429);
    }
    const entry = { id: crypto.randomUUID(), playerId: player.id, name: player.name, message: value, at: Date.now(), kind: "reaction" };
    this.room.chat.push(entry);
    this.room.chat = this.room.chat.slice(-50);
    await this.persist();
    await this.broadcastEvent({ type: "chat-message", entry });
    return jsonResponse({ ok: true });
  }

  systemMessage(message) {
    return { id: crypto.randomUUID(), playerId: null, name: "Sistema", message, at: Date.now(), kind: "system" };
  }

  async endGame() {
    if (this.room.status === "finished") {
      await this.recordGame();
      return jsonResponse({ ok: true });
    }
    if (this.room.round?.status === "playing") await this.completeRound("ended");
    return this.finishGame();
  }

  async finishGame() {
    const room = this.room;
    if (room.status !== "finished") {
      room.status = "finished";
      room.championId = [...(room.participants || room.players)].sort((a, b) => this.comparePlayers(a, b))[0]?.id || null;
      const champion = (room.participants || room.players).find((player) => player.id === room.championId);
      if (champion) {
        room.chat.push(this.systemMessage(`${champion.name} venceu a partida!`));
        room.chat = room.chat.slice(-50);
      }
      await this.persist();
      await this.updateDirectory();
    }
    await this.recordGame();
    await this.syncAlarm();
    await this.broadcast("game-finished");
    return jsonResponse({ ok: true });
  }

  comparePlayers(a, b) {
    return b.points - a.points ||
      a.errors - b.errors ||
      a.timeSpentMs - b.timeSpentMs ||
      b.wordsFound - a.wordsFound;
  }

  async recordGame() {
    const room = this.room;
    if (!room.gameId || room.rankingRecorded) return;
    const directory = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("global"));
    const response = await postJson(directory, "/_record-match", {
      matchId: room.gameId,
      roomCode: room.code,
      championId: room.championId || null,
      endedAt: Date.now(),
      players: (room.participants || room.players).map((player) => ({
        id: player.id,
        name: player.name,
        points: player.points,
        errors: player.errors,
        timeSpentMs: player.timeSpentMs,
        wordsFound: player.wordsFound,
        bestStreak: player.bestStreak,
        roundsPlayed: player.roundsPlayed
      }))
    });
    if (!response.ok) throw new Error("Não foi possível registrar o resultado no ranking.");
    room.rankingRecorded = true;
    await this.persist();
  }

  async leave(player) {
    const room = this.room;
    if (room.round?.status === "playing") {
      const progress = room.round.progress[player.id];
      if (progress?.status === "playing") this.completePlayer(player, progress, "lost", "left");
    }
    room.players = room.players.filter((entry) => entry.id !== player.id);
    if (room.status === "lobby") {
      room.participants = (room.participants || room.players).filter((entry) => entry.id !== player.id);
    }
    delete room.rateLimits[player.id];
    room.chat.push(this.systemMessage(`${player.name} saiu da sala.`));
    if (!room.players.length) return this.destroyRoom();
    if (player.id === room.hostId) room.hostId = room.players[0].id;
    if (room.round?.status === "playing" &&
        room.players.every((entry) => room.round.progress[entry.id]?.status !== "playing")) {
      await this.completeRound();
    } else {
      await this.persist();
      await this.syncAlarm();
      await this.updateDirectory();
      await this.broadcast();
    }
    return jsonResponse({ type: "left" });
  }

  async destroyRoom() {
    const code = this.room?.code || this.code;
    this.room = null;
    await this.ctx.storage.delete("room");
    await this.ctx.storage.deleteAlarm();
    await this.updateDirectory(true, code);
    return jsonResponse({ type: "left" });
  }

  async alarm() {
    return this.serialize(async () => {
      const room = this.room;
      if (!room) return;
      const now = Date.now();
      const expired = room.players.filter((player) =>
        !player.connected && player.disconnectedAt && player.disconnectedAt + RECONNECT_GRACE_MS <= now
      );
      for (const player of expired) {
        if (room.round?.status === "playing" && room.round.progress[player.id]?.status === "playing") {
          this.completePlayer(player, room.round.progress[player.id], "lost", "disconnected");
        }
      }
      if (expired.length) {
        const expiredIds = new Set(expired.map((player) => player.id));
        room.players = room.players.filter((player) => !expiredIds.has(player.id));
        if (room.status === "lobby") {
          room.participants = room.participants.filter((player) => !expiredIds.has(player.id));
        }
        if (!room.players.length) {
          if (room.status !== "finished") {
            await this.destroyRoom();
            return;
          }
          await this.persist();
          await this.syncAlarm();
          await this.recordGame();
          await this.destroyRoom();
          return;
        }
        if (!room.players.some((player) => player.id === room.hostId)) room.hostId = room.players[0].id;
        room.chat.push(this.systemMessage(`${expired.length} jogador(es) inativo(s) removido(s).`));
      }

      if (room.status === "playing" && room.round?.status === "playing" &&
          room.round.deadline && room.round.deadline <= now) {
        await this.completeRound("timeout");
      } else if (room.round?.status === "playing" &&
          Object.values(room.round.progress).every((entry) => entry.status !== "playing")) {
        await this.completeRound();
      } else if (room.status === "finished" && !room.rankingRecorded) {
        await this.recordGame();
        await this.broadcast("game-finished");
      } else {
        await this.persist();
        await this.broadcast();
      }
      await this.updateDirectory();
      await this.syncAlarm();
    });
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
    if (room.status === "playing" && room.round?.status === "playing" && room.round.deadline) {
      deadlines.push(room.round.deadline);
    }
    for (const player of room.players) {
      if (!player.connected && player.disconnectedAt) deadlines.push(player.disconnectedAt + RECONNECT_GRACE_MS);
    }
    if (room.status === "finished" && !room.rankingRecorded) deadlines.push(Date.now() + 15_000);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    else await this.ctx.storage.deleteAlarm();
  }

  async updateDirectory(remove = false, explicitCode = null) {
    const directory = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("global"));
    const room = this.room;
    const response = await postJson(directory, "/_room", remove ? { code: explicitCode || room?.code || this.code, remove: true } : {
      code: room.code,
      isPublic: room.settings.isPublic,
      status: room.status,
      players: room.players.length,
      maxPlayers: room.settings.maxPlayers,
      category: room.settings.category,
      format: "all",
      allowLateJoin: room.settings.allowLateJoin
    });
    if (!response.ok) throw new Error("Não foi possível atualizar o diretório de salas.");
  }

  async broadcast(type = "state") {
    const room = this.room;
    if (!room) return;
    await Promise.all(room.players.map(async (player) => {
      try {
        const response = await deliverToSession(this.env, player.sessionId, {
          type,
          room: this.snapshot(player.id)
        });
        if (!response.ok) console.error(`Falha ao enviar estado ao jogador ${player.id}: ${response.status}`);
      } catch (error) {
        console.error(`Falha ao notificar o jogador ${player.id}:`, error);
      }
    }));
  }

  async broadcastEvent(event) {
    await Promise.all(this.room.players.map(async (player) => {
      try {
        await deliverToSession(this.env, player.sessionId, event);
      } catch (error) {
        console.error(`Falha ao enviar evento ao jogador ${player.id}:`, error);
      }
    }));
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
      room: this.snapshot(player.id),
      playerId: player.id,
      token: player.token
    };
  }

  hasWords(category, difficulty) {
    return this.eligibleWords(category, difficulty).length > 0;
  }

  eligibleWords(category = "", difficulty = "") {
    return WORDS.filter((entry) =>
      (!category || entry.category === category) && (!difficulty || entry.difficulty === difficulty)
    );
  }

  publicRound(round, playerId) {
    const progress = round.progress[playerId] || this.newProgress();
    const revealAnswer = round.status === "complete" || progress.status === "won";
    return {
      masked: [...round.word.word].map((letter) =>
        !/\p{L}/u.test(letter) ? letter :
          (progress.guessed.includes(normalizeLetter(letter, this.room.settings.ignoreAccents)) ? letter : "")
      ),
      guessed: progress.guessed,
      mistakes: progress.mistakes,
      maxErrors: MAX_ERRORS,
      status: progress.status,
      hint: progress.hintUsed ? round.word.hint : null,
      category: round.word.category,
      roundNumber: round.roundNumber,
      winnerId: round.firstWinnerId,
      winnerIds: Object.entries(round.progress).filter(([, state]) => state.status === "won").map(([id]) => id),
      answer: revealAnswer ? round.word.word : null,
      ignoreAccents: this.room.settings.ignoreAccents,
      endReason: progress.endReason || round.endReason,
      startedAt: round.startedAt,
      timeLimit: this.room.settings.timeLimit,
      remainingMs: this.room.status === "paused" ? round.remainingMs : null,
      roundComplete: round.status === "complete",
      pointsEarned: progress.pointsEarned || 0
    };
  }

  snapshot(playerId = this.room?.players[0]?.id) {
    const room = this.room;
    if (!room) return null;
    const ordered = [...room.players].sort((a, b) => this.comparePlayers(a, b));
    return {
      code: room.code,
      status: room.status,
      format: "all",
      settings: room.settings,
      players: ordered.map((player, index) => ({
        id: player.id,
        name: player.name,
        avatar: [...player.name][0].toLocaleUpperCase("pt-BR"),
        points: player.points,
        wordsFound: player.wordsFound,
        roundsPlayed: player.roundsPlayed,
        wins: player.wins,
        errors: player.errors,
        timeSpentMs: player.timeSpentMs,
        streak: player.streak,
        bestStreak: player.bestStreak,
        rank: index + 1,
        ready: player.ready,
        roundStatus: room.round?.progress[player.id]?.status || null,
        connected: player.connected,
        host: player.id === room.hostId
      })),
      round: room.round ? this.publicRound(room.round, playerId) : null,
      roundNumber: room.roundNumber,
      roundsTotal: room.settings.rounds,
      roundComplete: room.round?.status === "complete",
      chat: room.chat.slice(-50),
      championId: room.championId || null,
      rankingRecorded: room.rankingRecorded
    };
  }
}
