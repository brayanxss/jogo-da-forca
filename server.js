const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { WORDS, CATEGORIES } = require("./wordbank");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.FORCA_DATA_DIR || path.join(__dirname, "data");
const SCORES_FILE = path.join(DATA_DIR, "scores.json");
const MAX_ERRORS = 6;
const rooms = new Map();
const soloGames = new Map();
const sockets = new Map();

function readScores() {
  try {
    return JSON.parse(fs.readFileSync(SCORES_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function getGlobalStats() {
  return Object.values(scores).reduce((stats, player) => {
    stats.games += player.games;
    stats.wordsFound += player.wordsFound;
    stats.totalTime += player.totalTime;
    return stats;
  }, { games: 0, wordsFound: 0, totalTime: 0 });
}

function broadcastPublicRooms() {
  const payload = JSON.stringify({ type: "public-rooms", rooms: publicRoomList() });
  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

let scores = readScores();

function saveScores() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${SCORES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(scores, null, 2));
  fs.renameSync(temporary, SCORES_FILE);
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  const name = value.trim().replace(/\s+/g, " ");
  return name.length <= 20 ? name : "";
}

function normalizeLetter(value, ignoreAccents) {
  if (typeof value !== "string" || !/^[a-záàâãéêíóôõúüç]$/i.test(value)) return null;
  const upper = value.toLocaleUpperCase("pt-BR");
  return ignoreAccents ? upper.normalize("NFD").replace(/\p{Diacritic}/gu, "") : upper;
}

function randomItem(items) {
  return items[crypto.randomInt(items.length)];
}

function makeRoomCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));
  return code;
}

function selectWord(room) {
  const eligible = WORDS.filter((entry) =>
    (!room.settings.category || entry.category === room.settings.category) &&
    (!room.settings.difficulty || entry.difficulty === room.settings.difficulty)
  );
  if (!eligible.length) throw new Error("Não há palavras disponíveis para a categoria e dificuldade selecionadas.");
  let pool = eligible.filter((entry) => !room.usedWords.has(entry.word));
  if (!pool.length) {
    room.usedWords.clear();
    pool = eligible;
  }
  const selected = randomItem(pool);
  room.usedWords.add(selected.word);
  return selected;
}

function publicRound(round) {
  return {
    masked: [...round.word.word].map((letter) =>
      !/\p{L}/u.test(letter) ? letter : (round.guessed.has(normalizeLetter(letter, round.ignoreAccents)) ? letter : "")
    ),
    guessed: [...round.guessed],
    mistakes: round.mistakes,
    maxErrors: MAX_ERRORS,
    status: round.status,
    hint: round.hintUsed ? round.word.hint : null,
    category: round.word.category,
    roundNumber: round.roundNumber,
    winnerId: round.winnerId || null,
    answer: round.status === "won" || round.status === "lost" ? round.word.word : null,
    endReason: round.endReason || null,
    startedAt: round.startedAt,
    timeLimit: round.timeLimit,
    remainingMs: round.remainingMs
  };
}

function publicRoomList() {
  return [...rooms.values()]
    .filter((room) => room.settings.isPublic && room.status === "lobby")
    .map((room) => ({
      code: room.code,
      players: room.players.size,
      maxPlayers: room.settings.maxPlayers,
      category: room.settings.category || "Aleatória",
      format: room.settings.format
    }));
}

function playerSnapshot(player) {
  return {
    id: player.id,
    name: player.name,
    points: player.points,
    wordsFound: player.wordsFound,
    errors: player.errors,
    connected: Boolean(player.socket && player.socket.readyState === WebSocket.OPEN),
    host: player.id === player.room.hostId
  };
}

function roomSnapshot(room) {
  return {
    code: room.code,
    status: room.status,
    format: room.settings.format,
    settings: room.settings,
    players: [...room.players.values()].map(playerSnapshot),
    round: room.round ? publicRound(room.round) : null,
    turnPlayerId: room.round && room.settings.format === "turns"
      ? [...room.players.values()][room.round.turnIndex]?.id || null
      : null,
    roundNumber: room.roundNumber,
    roundsTotal: room.settings.rounds
  };
}

function send(socket, type, data = {}) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...data }));
}

function broadcastRoom(room, type = "state") {
  const payload = JSON.stringify({ type, room: roomSnapshot(room) });
  for (const player of room.players.values()) {
    if (player.socket?.readyState === WebSocket.OPEN) player.socket.send(payload);
  }
}

function replyError(socket, message) {
  send(socket, "error", { message });
}

function updateScore(name, outcome, points, duration, errors) {
  const key = name.toLocaleLowerCase("pt-BR");
  const record = scores[key] || {
    name, games: 0, wordsFound: 0, wins: 0, currentStreak: 0, bestStreak: 0,
    points: 0, totalTime: 0, totalErrors: 0
  };
  record.name = name;
  record.games += 1;
  record.points += points;
  record.totalErrors += errors;
  if (outcome === "won") {
    record.wordsFound += 1;
    record.wins += 1;
    record.currentStreak += 1;
    record.bestStreak = Math.max(record.bestStreak, record.currentStreak);
    record.totalTime += duration;
  } else {
    record.currentStreak = 0;
  }
  scores[key] = record;
  saveScores();
}

function startRound(room) {
  if (room.roundNumber >= room.settings.rounds) {
    room.status = "finished";
    room.round = null;
    broadcastRoom(room, "game-finished");
    return;
  }
  room.roundNumber += 1;
  const word = selectWord(room);
  room.round = {
    word,
    guessed: new Set(),
    mistakes: 0,
    status: "playing",
    hintUsed: false,
    ignoreAccents: room.settings.ignoreAccents,
    roundNumber: room.roundNumber,
    startedAt: Date.now(),
    timeLimit: room.settings.timeLimit,
    winnerId: null,
    turnIndex: 0,
    lastActorId: null,
    scored: false,
    playerErrors: new Map(),
    playerStartPoints: new Map([...room.players.values()].map((player) => [player.id, player.points])),
    remainingMs: room.settings.timeLimit ? room.settings.timeLimit * 1000 : 0
  };
  room.status = "playing";
  if (room.settings.timeLimit) {
    room.round.timerStartedAt = Date.now();
    room.round.timer = setTimeout(() => completeRound(room, "lost", null, "timeout"), room.round.remainingMs);
    room.round.timer.unref();
  }
  broadcastRoom(room);
}

function completeRound(room, status, winner, endReason = status) {
  const round = room.round;
  if (!round || round.status !== "playing") return;
  round.status = status;
  round.endReason = endReason;
  round.winnerId = winner?.id || null;
  if (round.timer) clearTimeout(round.timer);
  if (status === "won" && winner) {
    const elapsed = (Date.now() - round.startedAt) / 1000;
    let points = room.settings.pointsPerWord;
    if (round.mistakes === 0) points += room.settings.perfectBonus;
    if (room.settings.speedEnabled && room.settings.speedBonus && elapsed <= room.settings.speedThreshold) points += room.settings.speedBonus;
    winner.points += points;
    winner.wordsFound += 1;
    const winnerErrors = round.playerErrors.get(winner.id) || 0;
    updateScore(winner.name, status, points - winnerErrors * room.settings.errorPenalty, elapsed, winnerErrors);
  }
  for (const player of room.players.values()) {
    const roundErrors = round.playerErrors.get(player.id) || 0;
    player.errors += roundErrors;
    if (player.id !== winner?.id) {
      updateScore(player.name, "lost", player.points - round.playerStartPoints.get(player.id), 0, roundErrors);
    }
  }
  broadcastRoom(room, status === "won" ? "round-won" : "round-lost");
}

function createRoom(socket, data) {
  if (sockets.has(socket)) return replyError(socket, "Saia da partida atual antes de criar outra sala.");
  if (rooms.size >= 500) return replyError(socket, "O servidor está com muitas salas abertas. Tente novamente mais tarde.");
  const name = cleanName(data.name);
  if (!name) return replyError(socket, "Informe um apelido de 1 a 20 caracteres.");
  if (data.settings?.format && !["all", "turns"].includes(data.settings.format)) return replyError(socket, "Formato de partida inválido.");
  if (data.settings?.category && !CATEGORIES.includes(data.settings.category)) return replyError(socket, "Categoria inválida.");
  const settings = data.settings || {};
  const difficulty = ["facil", "medio", "dificil"].includes(settings.difficulty) ? settings.difficulty : "";
  if (settings.difficulty && !difficulty) return replyError(socket, "Dificuldade inválida.");
  if (!WORDS.some((entry) => (!settings.category || entry.category === settings.category) &&
    (!difficulty || entry.difficulty === difficulty))) return replyError(socket, "Não há palavras para essa categoria e dificuldade.");
  const room = {
    code: makeRoomCode(),
    hostId: crypto.randomUUID(),
    status: "lobby",
    roundNumber: 0,
    usedWords: new Set(),
    players: new Map(),
    settings: {
      maxPlayers: Math.min(8, Math.max(2, Number(settings.maxPlayers) || 8)),
      category: settings.category || "",
      difficulty,
      timeLimit: Math.max(0, Math.min(300, Number(settings.timeLimit) || 0)),
      rounds: Math.max(1, Math.min(50, Number(settings.rounds) || 10)),
      hints: settings.hints !== false,
      speedBonus: settings.speedBonus === false ? 0 : (Number(settings.speedBonus) || 10),
      speedEnabled: settings.speedEnabled !== false,
      speedThreshold: Math.max(5, Number(settings.speedThreshold) || 30),
      pointsPerWord: Math.max(0, Number(settings.pointsPerWord) || 100),
      perfectBonus: Math.max(0, Number(settings.perfectBonus) || 20),
      errorPenalty: Math.max(0, Number(settings.errorPenalty) || 0),
      ignoreAccents: settings.ignoreAccents !== false,
      format: settings.format === "turns" ? "turns" : "all",
      isPublic: settings.isPublic === true
    }
  };
  const player = { id: room.hostId, name, socket, points: 0, wordsFound: 0, errors: 0, room };
  room.players.set(player.id, player);
  rooms.set(room.code, room);
  sockets.set(socket, { type: "room", room, player });
  player.token = crypto.randomBytes(24).toString("base64url");
  send(socket, "joined", { room: roomSnapshot(room), playerId: player.id, token: player.token });
  broadcastPublicRooms();
}

function joinRoom(socket, data) {
  if (sockets.has(socket)) return replyError(socket, "Saia da partida atual antes de entrar em outra sala.");
  const name = cleanName(data.name);
  const code = typeof data.code === "string" ? data.code.trim().toUpperCase() : "";
  const room = rooms.get(code);
  if (!name) return replyError(socket, "Informe um apelido de 1 a 20 caracteres.");
  if (!/^[A-F0-9]{6}$/.test(code) || !room) return replyError(socket, "Sala não encontrada. Confira o código.");
  if (room.players.size >= room.settings.maxPlayers) return replyError(socket, "A sala está cheia.");
  if (room.status !== "lobby") return replyError(socket, "A partida já começou.");
  if ([...room.players.values()].some((player) => player.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
    return replyError(socket, "Esse apelido já está em uso na sala.");
  }
  const player = { id: crypto.randomUUID(), name, socket, points: 0, wordsFound: 0, errors: 0, room };
  player.token = crypto.randomBytes(24).toString("base64url");
  room.players.set(player.id, player);
  sockets.set(socket, { type: "room", room, player });
  send(socket, "joined", { room: roomSnapshot(room), playerId: player.id, token: player.token });
  broadcastRoom(room);
  broadcastPublicRooms();
}

function resumeRoom(socket, data) {
  const code = typeof data.code === "string" ? data.code.trim().toUpperCase() : "";
  const token = typeof data.token === "string" ? data.token : "";
  const room = rooms.get(code);
  const player = room && [...room.players.values()].find((entry) => entry.token === token);
  if (!player) return replyError(socket, "Não foi possível retomar essa sessão.");
  if (player.socket && player.socket !== socket) {
    sockets.delete(player.socket);
    player.socket.close(4001, "Sessão retomada em outra conexão");
  }
  player.socket = socket;
  sockets.set(socket, { type: "room", room, player });
  send(socket, "joined", { room: roomSnapshot(room), playerId: player.id, token: player.token });
  broadcastRoom(room);
}

function newSolo(socket, data) {
  const previous = sockets.get(socket);
  if (previous?.type === "room") return replyError(socket, "Saia da sala atual antes de iniciar uma partida solo.");
  if (previous?.type === "solo") soloGames.delete(previous.game.id);
  const name = cleanName(data.name);
  if (!name) return replyError(socket, "Informe um apelido de 1 a 20 caracteres.");
  if (data.category && !CATEGORIES.includes(data.category)) return replyError(socket, "Categoria inválida.");
  if (data.difficulty && !["facil", "medio", "dificil"].includes(data.difficulty)) return replyError(socket, "Dificuldade inválida.");
  const difficulty = ["facil", "medio", "dificil"].includes(data.difficulty) ? data.difficulty : "";
  const pool = WORDS.filter((entry) => (!difficulty || entry.difficulty === difficulty) &&
    (!data.category || entry.category === data.category));
  if (!pool.length) return replyError(socket, "Não há palavras para essa combinação.");
  const secret = randomItem(pool);
  const game = {
    id: crypto.randomUUID(), name, word: secret, guessed: new Set(), mistakes: 0,
    status: "playing", startedAt: Date.now(), hintUsed: false,
    ignoreAccents: data.ignoreAccents !== false, timeLimit: 0, roundNumber: 1,
    scored: false
  };
  soloGames.set(game.id, game);
  sockets.set(socket, { type: "solo", game });
  send(socket, "solo-state", { game: publicRound({ ...game, round: undefined }), gameId: game.id, points: 0 });
}

function soloSnapshot(game) {
  return publicRound(game);
}

function guessSolo(socket, game, data) {
  if (game.status !== "playing") return replyError(socket, "Essa rodada já terminou.");
  const letter = normalizeLetter(data.letter, game.ignoreAccents);
  if (!letter) return replyError(socket, "Escolha uma letra válida.");
  if (game.guessed.has(letter)) return replyError(socket, "Essa letra já foi escolhida.");
  game.guessed.add(letter);
  if (![...game.word.word].some((char) => /\p{L}/u.test(char) && normalizeLetter(char, game.ignoreAccents) === letter)) game.mistakes += 1;
  const solved = [...game.word.word].every((char) => !/\p{L}/u.test(char) || game.guessed.has(normalizeLetter(char, game.ignoreAccents)));
  if (solved || game.mistakes >= MAX_ERRORS) {
    game.status = solved ? "won" : "lost";
    const elapsed = (Date.now() - game.startedAt) / 1000;
    const points = solved ? 100 + (game.mistakes === 0 ? 20 : 0) + (elapsed <= 30 ? 10 : 0) : 0;
    updateScore(game.name, game.status, points, elapsed, game.mistakes);
    game.scored = true;
    return send(socket, "solo-state", { game: soloSnapshot(game), gameId: game.id, points });
  }
  send(socket, "solo-state", { game: soloSnapshot(game), gameId: game.id, points: 0 });
}

function takeTurn(room, player) {
  const players = [...room.players.values()];
  if (!players.length) return;
  room.round.turnIndex = (players.findIndex((entry) => entry.id === player.id) + 1) % players.length;
  room.round.lastActorId = player.id;
}

function guessRoom(socket, context, data) {
  const { room, player } = context;
  const round = room.round;
  if (!round || room.status !== "playing" || round.status !== "playing") return replyError(socket, "Não há uma rodada em andamento.");
  if (room.settings.format === "turns" && [...room.players.values()][round.turnIndex]?.id !== player.id) return replyError(socket, "Aguarde sua vez.");
  const letter = normalizeLetter(data.letter, round.ignoreAccents);
  if (!letter) return replyError(socket, "Escolha uma letra válida.");
  if (round.guessed.has(letter)) return replyError(socket, "Essa letra já foi escolhida.");
  round.guessed.add(letter);
  const correct = [...round.word.word].some((char) => /\p{L}/u.test(char) && normalizeLetter(char, round.ignoreAccents) === letter);
  if (!correct) {
    round.mistakes += 1;
    round.playerErrors.set(player.id, (round.playerErrors.get(player.id) || 0) + 1);
    if (room.settings.errorPenalty) player.points = Math.max(0, player.points - room.settings.errorPenalty);
  }
  const solved = [...round.word.word].every((char) => !/\p{L}/u.test(char) || round.guessed.has(normalizeLetter(char, round.ignoreAccents)));
  if (solved) completeRound(room, "won", player);
  else if (round.mistakes >= MAX_ERRORS) completeRound(room, "lost", null);
  else {
    if (room.settings.format === "turns") takeTurn(room, player);
    broadcastRoom(room);
  }
}

function handleMessage(socket, message) {
  let data;
  try {
    data = JSON.parse(message.toString());
  } catch {
    return replyError(socket, "Mensagem inválida.");
  }
  if (!data || typeof data.type !== "string") return replyError(socket, "Ação inválida.");
  if (data.type === "create-room") return createRoom(socket, data);
  if (data.type === "join-room") return joinRoom(socket, data);
  if (data.type === "resume-room") return resumeRoom(socket, data);
  if (data.type === "solo-start") return newSolo(socket, data);
  if (data.type === "leave-solo") {
    const context = sockets.get(socket);
    if (context?.type !== "solo") return replyError(socket, "Não há uma partida solo para sair.");
    soloGames.delete(context.game.id);
    sockets.delete(socket);
    return;
  }
  if (data.type === "ranking") return send(socket, "ranking", { players: getRanking(), stats: getGlobalStats() });
  if (data.type === "public-rooms") return send(socket, "public-rooms", { rooms: publicRoomList() });
  const context = sockets.get(socket);
  if (!context) return replyError(socket, "Entre em uma partida primeiro.");
  if (data.type === "guess") {
    return context.type === "solo" ? guessSolo(socket, context.game, data) : guessRoom(socket, context, data);
  }
  if (data.type === "hint") {
    const round = context.type === "solo" ? context.game : context.room.round;
    const enabled = context.type === "solo" || context.room.settings.hints;
    if (!enabled) return replyError(socket, "As dicas estão desativadas nesta sala.");
    if (context.type === "room" && context.room.status !== "playing") return replyError(socket, "As dicas ficam indisponíveis enquanto a partida está pausada.");
    if (!round || round.status !== "playing" || round.hintUsed) return replyError(socket, "A dica não está disponível.");
    round.hintUsed = true;
    if (context.type === "solo") send(socket, "solo-state", { game: soloSnapshot(round), gameId: round.id });
    else broadcastRoom(context.room);
    return;
  }
  if (data.type === "start-game" || data.type === "next-round" || data.type === "update-settings" ||
      data.type === "leave-room" || data.type === "pause-game" || data.type === "resume-game" || data.type === "end-game") {
    if (context.type !== "room") return replyError(socket, "Ação disponível apenas em salas.");
    const { room, player } = context;
    if (data.type === "leave-room") return removePlayer(socket);
    if (player.id !== room.hostId) return replyError(socket, "Somente o anfitrião pode controlar a sala.");
    if (data.type === "update-settings") {
      if (room.status !== "lobby") return replyError(socket, "As opções não podem ser alteradas durante a partida.");
      const settings = data.settings || {};
      if (settings.category && !CATEGORIES.includes(settings.category)) return replyError(socket, "Categoria inválida.");
      const difficulty = ["facil", "medio", "dificil"].includes(settings.difficulty) ? settings.difficulty : "";
      if (!WORDS.some((entry) => (!settings.category || entry.category === settings.category) &&
        (!difficulty || entry.difficulty === difficulty))) return replyError(socket, "Não há palavras para essa categoria e dificuldade.");
      room.settings = {
        ...room.settings,
        maxPlayers: Math.min(8, Math.max(room.players.size, Number(settings.maxPlayers) || room.settings.maxPlayers)),
        category: settings.category || "",
        difficulty,
        timeLimit: Math.max(0, Math.min(300, Number(settings.timeLimit) || 0)),
        rounds: Math.max(1, Math.min(50, Number(settings.rounds) || room.settings.rounds)),
        hints: settings.hints === true,
        speedBonus: Math.max(0, Math.min(1000, Number(settings.speedBonus) || 0)),
        speedEnabled: settings.speedEnabled === true,
        speedThreshold: Math.max(5, Math.min(600, Number(settings.speedThreshold) || 30)),
        pointsPerWord: Math.max(0, Math.min(10000, Number(settings.pointsPerWord) || 0)),
        perfectBonus: Math.max(0, Math.min(10000, Number(settings.perfectBonus) || 0)),
        errorPenalty: Math.max(0, Math.min(10000, Number(settings.errorPenalty) || 0)),
        ignoreAccents: settings.ignoreAccents !== false,
        format: settings.format === "turns" ? "turns" : "all",
        isPublic: settings.isPublic === true
      };
      broadcastPublicRooms();
      return broadcastRoom(room);
    }
    if (data.type === "start-game") {
      if (room.status !== "lobby" || room.players.size < 2) return replyError(socket, "A sala precisa de pelo menos 2 jogadores.");
      room.players.forEach((entry) => { entry.points = 0; entry.wordsFound = 0; entry.errors = 0; });
      room.roundNumber = 0;
      room.usedWords.clear();
      startRound(room);
      return;
    }
    if (data.type === "pause-game") {
      if (room.status !== "playing" || !room.round) return replyError(socket, "Não há uma partida em andamento.");
      if (room.round.timer) {
        clearTimeout(room.round.timer);
        room.round.remainingMs = Math.max(0, room.round.remainingMs - (Date.now() - room.round.timerStartedAt));
      }
      room.round.pausedAt = Date.now();
      room.status = "paused";
      return broadcastRoom(room, "state");
    }
    if (data.type === "resume-game") {
      if (room.status !== "paused" || !room.round) return replyError(socket, "A partida não está pausada.");
      const pausedFor = Date.now() - room.round.pausedAt;
      room.round.startedAt += pausedFor;
      room.status = "playing";
      if (room.settings.timeLimit) {
        room.round.timerStartedAt = Date.now();
        room.round.timer = setTimeout(() => completeRound(room, "lost", null, "timeout"), room.round.remainingMs);
        room.round.timer.unref();
      }
      return broadcastRoom(room, "state");
    }
    if (data.type === "end-game") {
      if (room.round?.status === "playing") completeRound(room, "lost", null, "ended");
      room.status = "finished";
      return broadcastRoom(room, "game-finished");
    }
    if (data.type === "next-round") {
      if (!room.round || room.round.status === "playing") return replyError(socket, "A rodada atual ainda está em andamento.");
      return startRound(room);
    }
  }
  replyError(socket, "Ação desconhecida.");
}

function removePlayer(socket) {
  const context = sockets.get(socket);
  if (!context || context.type !== "room") return;
  const { room, player } = context;
  const activeTurnId = room.round && room.settings.format === "turns"
    ? [...room.players.values()][room.round.turnIndex]?.id
    : null;
  room.players.delete(player.id);
  sockets.delete(socket);
  if (!room.players.size) {
    if (room.round?.timer) clearTimeout(room.round.timer);
    rooms.delete(room.code);
    broadcastPublicRooms();
    return;
  }
  if (room.round && room.settings.format === "turns") {
    const players = [...room.players.values()];
    const activeTurnIndex = players.findIndex((entry) => entry.id === activeTurnId);
    room.round.turnIndex = activeTurnIndex >= 0 ? activeTurnIndex : room.round.turnIndex % players.length;
  }
  if (room.hostId === player.id) {
    room.hostId = room.players.keys().next().value;
    room.players.get(room.hostId).id = room.hostId;
  }
  broadcastRoom(room);
  broadcastPublicRooms();
}

function getRanking() {
  return Object.values(scores).map((player) => ({
    name: player.name, games: player.games, wordsFound: player.wordsFound,
    wins: player.wins, bestStreak: player.bestStreak, points: player.points,
    averageTime: player.wordsFound ? Math.round(player.totalTime / player.wordsFound) : null,
    totalErrors: player.totalErrors
  })).sort((a, b) => b.points - a.points || b.wordsFound - a.wordsFound || a.totalErrors - b.totalErrors).slice(0, 20);
}

const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const server = http.createServer((request, response) => {
  let pathname;
  try {
    pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  } catch {
    response.writeHead(400);
    return response.end("Bad request");
  }
  if (pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ ok: true, words: WORDS.length }));
  }
  let requested;
  try {
    requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    response.writeHead(400);
    return response.end("Bad request");
  }
  const file = path.resolve(PUBLIC_DIR, requested);
  if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`) && file !== path.join(PUBLIC_DIR, "index.html")) {
    response.writeHead(403); return response.end("Forbidden");
  }
  fs.readFile(file, (error, content) => {
    if (error) {
      response.writeHead(404); return response.end("Not found");
    }
    response.writeHead(200, { "content-type": mimeTypes[path.extname(file)] || "application/octet-stream" });
    response.end(content);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on("connection", (socket) => {
  socket.on("message", (message) => handleMessage(socket, message));
  socket.on("close", () => {
    const context = sockets.get(socket);
    if (context?.type === "room" && context.player.socket === socket) {
      context.player.socket = null;
      broadcastRoom(context.room);
      setTimeout(() => {
        if (context.player.socket === null && context.room.players.has(context.player.id)) {
          removeDisconnectedPlayer(context.room, context.player);
        }
      }, 60_000).unref();
    }
    if (context?.type === "solo") soloGames.delete(context.game.id);
    sockets.delete(socket);
  });
});

function removeDisconnectedPlayer(room, player) {
  const activeTurnId = room.round && room.settings.format === "turns"
    ? [...room.players.values()][room.round.turnIndex]?.id
    : null;
  room.players.delete(player.id);
  if (!room.players.size) {
    if (room.round?.timer) clearTimeout(room.round.timer);
    rooms.delete(room.code);
    broadcastPublicRooms();
  }
  else {
    if (room.round && room.settings.format === "turns") {
      const players = [...room.players.values()];
      const activeTurnIndex = players.findIndex((entry) => entry.id === activeTurnId);
      room.round.turnIndex = activeTurnIndex >= 0 ? activeTurnIndex : room.round.turnIndex % players.length;
    }
    if (room.hostId === player.id) room.hostId = room.players.keys().next().value;
    broadcastRoom(room);
    broadcastPublicRooms();
  }
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Jogo da Forca disponível em http://localhost:${PORT}`);
  });
}

module.exports = {
  normalizeLetter, WORDS, getRanking, getGlobalStats, MAX_ERRORS,
  server, rooms, selectWord, startRound
};
