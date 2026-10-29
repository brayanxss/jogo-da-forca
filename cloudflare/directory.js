import { jsonResponse, postJson, randomRoomCode } from "./shared.js";

const EMPTY_STATS = () => ({ games: 0, wordsFound: 0, totalTime: 0 });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getRanking(db, period = "general") {
  if (!db) return { type: "error", message: "O banco D1 não está configurado." };
  const weekly = period === "weekly";
  const rows = weekly
    ? await db.prepare(
      `SELECT player_name AS name, SUM(points) AS points, SUM(errors) AS totalErrors,
              SUM(time_spent_ms) AS totalTimeMs, SUM(words_found) AS wordsFound,
              SUM(rounds_played) AS roundsPlayed, SUM(match_win) AS wins,
              MAX(best_streak) AS bestStreak, COUNT(DISTINCT match_id) AS games
       FROM match_results
       WHERE strftime('%Y-%W', ended_at / 1000, 'unixepoch') = strftime('%Y-%W', 'now')
       GROUP BY player_key
       ORDER BY points DESC, totalErrors ASC, totalTimeMs ASC, wordsFound DESC
       LIMIT 20`
    ).all()
    : await db.prepare(
      `SELECT display_name AS name, points, errors AS totalErrors,
              time_spent_ms AS totalTimeMs, words_found AS wordsFound,
              rounds_played AS roundsPlayed, wins, best_streak AS bestStreak, games
       FROM player_stats
       ORDER BY points DESC, totalErrors ASC, totalTimeMs ASC, wordsFound DESC
       LIMIT 20`
    ).all();
  const players = rows.results.map((player) => ({
    ...player,
    averageTime: player.wordsFound ? Math.round(player.totalTimeMs / player.wordsFound / 1000) : null,
    accuracy: player.roundsPlayed ? Math.round(player.wordsFound * 100 / player.roundsPlayed) : 0
  }));
  const stats = weekly
    ? await db.prepare(
      `SELECT COUNT(DISTINCT match_id) AS games, COALESCE(SUM(words_found), 0) AS wordsFound,
              COALESCE(SUM(time_spent_ms), 0) / 1000 AS totalTime
       FROM match_results
       WHERE strftime('%Y-%W', ended_at / 1000, 'unixepoch') = strftime('%Y-%W', 'now')`
    ).first()
    : await db.prepare(
      `SELECT COUNT(DISTINCT match_id) AS games,
              COALESCE(SUM(words_found), 0) AS wordsFound,
              COALESCE(SUM(time_spent_ms), 0) / 1000 AS totalTime
       FROM match_results`
    ).first();
  return { type: "ranking", period: weekly ? "weekly" : "general", players, stats: stats || EMPTY_STATS() };
}

export class GameDirectory {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.rooms = (await ctx.storage.get("rooms")) || {};
    });
  }

  serialize(operation) {
    const result = this.queue.then(async () => {
      await this.ready;
      return operation();
    });
    this.queue = result.catch((error) => {
      console.error("Erro na operação do diretório:", error);
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
      switch (url.pathname) {
        case "/_allocate": return this.allocate();
        case "/_release": return this.release(data);
        case "/_room": return this.updateRoom(data);
        case "/_public-rooms": return this.publicRooms();
        case "/_record-match": return this.recordMatch(data);
        case "/_record": return this.recordSolo(data);
        case "/_ranking": return this.ranking(data);
        default: return jsonResponse({ error: "Unknown directory action" }, 404);
      }
    });
  }

  async allocate() {
    let code;
    do {
      code = randomRoomCode();
    } while (this.rooms[code]);
    this.rooms[code] = { reserved: true, reservedAt: Date.now(), public: false };
    await this.ctx.storage.put("rooms", this.rooms);
    await this.syncAlarm();
    return jsonResponse({ code });
  }

  async release(data) {
    if (typeof data.code !== "string") return jsonResponse({ error: "Código inválido." }, 400);
    delete this.rooms[data.code];
    await this.ctx.storage.put("rooms", this.rooms);
    await this.syncAlarm();
    return jsonResponse({ ok: true });
  }

  async updateRoom(data) {
    if (typeof data.code !== "string" || !/^[A-F0-9]{6}$/.test(data.code)) {
      return jsonResponse({ error: "Código inválido." }, 400);
    }
    if (data.remove) {
      delete this.rooms[data.code];
    } else {
      if (!this.rooms[data.code]) return jsonResponse({ error: "Sala não encontrada." }, 404);
      this.rooms[data.code] = {
        reserved: false,
        public: data.isPublic === true && (data.status === "lobby" || (data.status === "playing" && data.allowLateJoin === true)),
        players: Math.max(0, Math.min(8, Number(data.players) || 0)),
        maxPlayers: Math.max(2, Math.min(8, Number(data.maxPlayers) || 8)),
        category: typeof data.category === "string" ? data.category : "Aleatória",
        format: "all",
        status: data.status,
        allowLateJoin: data.allowLateJoin === true
      };
    }
    await this.ctx.storage.put("rooms", this.rooms);
    await this.syncAlarm();
    return jsonResponse({ ok: true });
  }

  publicRooms() {
    const rooms = Object.entries(this.rooms)
      .filter(([, room]) => room.public && !room.reserved && room.players < room.maxPlayers)
      .map(([code, room]) => ({
        code,
        players: room.players,
        maxPlayers: room.maxPlayers,
        category: room.category,
        format: "all"
      }));
    return jsonResponse({ type: "public-rooms", rooms });
  }

  async recordMatch(data) {
    if (!this.env.DB) return jsonResponse({ error: "O banco D1 não está configurado." }, 503);
    if (typeof data.matchId !== "string" || !UUID_PATTERN.test(data.matchId) ||
        !Array.isArray(data.players) || data.players.length < 1 || data.players.length > 8 ||
        (data.roomCode !== null && data.roomCode !== undefined &&
          (typeof data.roomCode !== "string" || !/^[A-F0-9]{6}$/.test(data.roomCode)))) {
      return jsonResponse({ error: "Resultado de partida inválido." }, 400);
    }
    if (data.championId !== null && data.championId !== undefined &&
        (typeof data.championId !== "string" || !data.players.some((player) => player?.id === data.championId))) {
      return jsonResponse({ error: "Campeão da partida inválido." }, 400);
    }
    const endedAt = data.endedAt === undefined
      ? Date.now()
      : (Number.isSafeInteger(data.endedAt) && data.endedAt >= 0 ? data.endedAt : null);
    if (endedAt === null) return jsonResponse({ error: "Horário de conclusão inválido." }, 400);
    const statements = [];
    const playerKeys = new Set();
    const playerIds = new Set();
    for (const player of data.players) {
      if (!player || typeof player !== "object" || typeof player.id !== "string") {
        return jsonResponse({ error: "Estatísticas de jogador inválidas." }, 400);
      }
      const name = typeof player.name === "string" ? player.name.trim().replace(/\s+/g, " ") : "";
      const playerKey = name.toLocaleLowerCase("pt-BR");
      const numbers = ["points", "errors", "timeSpentMs", "wordsFound", "roundsPlayed", "bestStreak"];
      if (!player.id || playerIds.has(player.id) || !name || name.length > 20 ||
          playerKeys.has(playerKey) || numbers.some((key) =>
        !Number.isSafeInteger(player[key]) || player[key] < 0
      )) {
        return jsonResponse({ error: "Estatísticas de jogador inválidas." }, 400);
      }
      playerKeys.add(playerKey);
      playerIds.add(player.id);
      const matchWin = player.id === data.championId ? 1 : 0;
      statements.push(
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO match_results
            (match_id, player_key, player_name, room_code, points, errors, time_spent_ms,
             words_found, rounds_played, match_win, best_streak, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          data.matchId,
          playerKey,
          name,
          data.roomCode || null,
          player.points,
          player.errors,
          player.timeSpentMs,
          player.wordsFound,
          player.roundsPlayed,
          matchWin,
          player.bestStreak,
          endedAt
        ),
        this.env.DB.prepare(
          `INSERT INTO player_stats
            (name_key, display_name, games, wins, points, errors, time_spent_ms,
             words_found, rounds_played, best_streak, last_played)
           SELECT ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE changes() = 1
           ON CONFLICT(name_key) DO UPDATE SET
             display_name = excluded.display_name,
             games = player_stats.games + excluded.games,
             wins = player_stats.wins + excluded.wins,
             points = player_stats.points + excluded.points,
             errors = player_stats.errors + excluded.errors,
             time_spent_ms = player_stats.time_spent_ms + excluded.time_spent_ms,
             words_found = player_stats.words_found + excluded.words_found,
             rounds_played = player_stats.rounds_played + excluded.rounds_played,
             best_streak = MAX(player_stats.best_streak, excluded.best_streak),
             last_played = MAX(player_stats.last_played, excluded.last_played)`
        ).bind(
          playerKey,
          name,
          matchWin,
          player.points,
          player.errors,
          player.timeSpentMs,
          player.wordsFound,
          player.roundsPlayed,
          player.bestStreak,
          endedAt
        )
      );
    }
    await this.env.DB.batch(statements);
    return jsonResponse({ ok: true, duplicateSafe: true });
  }

  async recordSolo(data) {
    if (!this.env.DB) return jsonResponse({ error: "O banco D1 não está configurado." }, 503);
    const name = typeof data.name === "string" ? data.name.trim().replace(/\s+/g, " ") : "";
    const points = Number(data.points);
    const errors = Number(data.errors);
    const duration = Number(data.duration);
    if (!UUID_PATTERN.test(data.gameId || "") || !name || name.length > 20 ||
        !Number.isSafeInteger(points) || points < 0 ||
        !Number.isSafeInteger(errors) || errors < 0 || errors > 6 ||
        !Number.isFinite(duration) || duration < 0 ||
        !["won", "lost"].includes(data.outcome)) {
      return jsonResponse({ error: "Resultado solo inválido." }, 400);
    }
    const key = name.toLocaleLowerCase("pt-BR");
    const won = data.outcome === "won";
    return this.recordMatch({
      matchId: data.gameId,
      roomCode: null,
      championId: won ? key : null,
      endedAt: Date.now(),
      players: [{
        id: key,
        name,
        points,
        errors,
        timeSpentMs: Math.round(duration * 1000),
        wordsFound: won ? 1 : 0,
        roundsPlayed: 1,
        bestStreak: won ? 1 : 0
      }]
    });
  }

  async ranking(data) {
    if (!this.env.DB) return jsonResponse({ error: "O banco D1 não está configurado." }, 503);
    return jsonResponse(await getRanking(this.env.DB, data.period));
  }

  async alarm() {
    await this.ready;
    const expiredBefore = Date.now() - 5 * 60_000;
    const expiredCodes = Object.entries(this.rooms)
      .filter(([, room]) => room.reserved && room.reservedAt <= expiredBefore)
      .map(([code]) => code);
    for (const code of expiredCodes) delete this.rooms[code];
    if (expiredCodes.length) await this.ctx.storage.put("rooms", this.rooms);
    await this.syncAlarm();
  }

  async syncAlarm() {
    const pending = Object.values(this.rooms)
      .filter((room) => room.reserved)
      .map((room) => room.reservedAt + 5 * 60_000);
    if (pending.length) await this.ctx.storage.setAlarm(Math.min(...pending));
    else await this.ctx.storage.deleteAlarm();
  }
}
