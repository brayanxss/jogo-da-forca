import { jsonResponse, postJson, randomRoomCode } from "./shared.js";

const EMPTY_STATS = () => ({ games: 0, wordsFound: 0, totalTime: 0 });

export class GameDirectory {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.rooms = (await ctx.storage.get("rooms")) || {};
      this.scores = (await ctx.storage.get("scores")) || {};
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
    const data = await request.json();
    return this.serialize(async () => {
      if (url.pathname === "/_allocate") {
        let code;
        do {
          code = randomRoomCode();
        } while (this.rooms[code]);
        this.rooms[code] = { reserved: true, reservedAt: Date.now(), public: false };
        await this.ctx.storage.put("rooms", this.rooms);
        await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
        return jsonResponse({ code });
      }

      if (url.pathname === "/_release") {
        delete this.rooms[data.code];
        await this.ctx.storage.put("rooms", this.rooms);
        await this.syncAlarm();
        return jsonResponse({ ok: true });
      }

      if (url.pathname === "/_room") {
        if (!this.rooms[data.code]) return jsonResponse({ error: "Sala não encontrada." }, 404);
        if (data.remove) delete this.rooms[data.code];
        else this.rooms[data.code] = {
          reserved: false,
          public: data.isPublic === true && data.status === "lobby",
          players: data.players,
          maxPlayers: data.maxPlayers,
          category: data.category || "Aleatória",
          format: data.format || "all"
        };
        await this.ctx.storage.put("rooms", this.rooms);
        await this.syncAlarm();
        return jsonResponse({ ok: true });
      }

      if (url.pathname === "/_public-rooms") {
        const rooms = Object.entries(this.rooms)
          .filter(([, room]) => room.public && !room.reserved)
          .map(([code, room]) => ({
            code,
            players: room.players,
            maxPlayers: room.maxPlayers,
            category: room.category,
            format: room.format
          }));
        return jsonResponse({ type: "public-rooms", rooms });
      }

      if (url.pathname === "/_record") {
        const key = data.name.toLocaleLowerCase("pt-BR");
        const record = this.scores[key] || {
          name: data.name,
          games: 0,
          wordsFound: 0,
          wins: 0,
          currentStreak: 0,
          bestStreak: 0,
          points: 0,
          totalTime: 0,
          totalErrors: 0
        };
        record.name = data.name;
        record.games += 1;
        record.points += data.points;
        record.totalErrors += data.errors;
        if (data.outcome === "won") {
          record.wordsFound += 1;
          record.wins += 1;
          record.currentStreak += 1;
          record.bestStreak = Math.max(record.bestStreak, record.currentStreak);
          record.totalTime += data.duration;
        } else {
          record.currentStreak = 0;
        }
        this.scores[key] = record;
        await this.ctx.storage.put("scores", this.scores);
        return jsonResponse({ ok: true });
      }

      if (url.pathname === "/_ranking") {
        const players = Object.values(this.scores).map((player) => ({
          name: player.name,
          games: player.games,
          wordsFound: player.wordsFound,
          wins: player.wins,
          bestStreak: player.bestStreak,
          points: player.points,
          averageTime: player.wordsFound ? Math.round(player.totalTime / player.wordsFound) : null,
          totalErrors: player.totalErrors
        })).sort((a, b) => b.points - a.points || b.wordsFound - a.wordsFound || a.totalErrors - b.totalErrors).slice(0, 20);
        const stats = Object.values(this.scores).reduce((total, player) => ({
          games: total.games + player.games,
          wordsFound: total.wordsFound + player.wordsFound,
          totalTime: total.totalTime + player.totalTime
        }), EMPTY_STATS());
        return jsonResponse({ type: "ranking", players, stats });
      }

      return jsonResponse({ error: "Unknown directory action" }, 404);
    });
  }

  async alarm() {
    await this.ready;
    const expiredBefore = Date.now() - 5 * 60_000;
    const reservedCodes = Object.entries(this.rooms)
      .filter(([, room]) => room.reserved && room.reservedAt <= expiredBefore)
      .map(([code]) => code);
    for (const code of reservedCodes) delete this.rooms[code];
    if (reservedCodes.length) await this.ctx.storage.put("rooms", this.rooms);
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
