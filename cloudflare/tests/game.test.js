import { env, exports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { WORDS } from "../shared.js";

async function post(stub, path, body) {
  return stub.fetch(`https://test.forca${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function createRoom() {
  const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
  const allocation = await post(directory, "/_allocate", {});
  const { code } = await allocation.json();
  const room = env.ROOMS.get(env.ROOMS.idFromName(code));
  const hostSession = env.SESSIONS.newUniqueId().toString();
  const guestSession = env.SESSIONS.newUniqueId().toString();
  const created = await post(room, "/_create", {
    code,
    sessionId: hostSession,
    name: "Jogador anfitrião",
    settings: { rounds: 2, timeLimit: 0 }
  });
  const host = await created.json();
  const joined = await post(room, "/_join", {
    code,
    sessionId: guestSession,
    name: "Jogador convidado"
  });
  const guest = await joined.json();
  return { room, code, hostSession, guestSession, host, guest };
}

describe("Migração Cloudflare Workers", () => {
  afterEach(async () => reset());

  it("mantém exatamente 1.000 palavras únicas no bundle Cloudflare", () => {
    expect(WORDS).toHaveLength(1000);
    expect(new Set(WORDS.map(({ word }) => word.toLocaleLowerCase("pt-BR"))).size).toBe(1000);
    const categoryCounts = Object.values(WORDS.reduce((counts, entry) => {
      counts[entry.category] = (counts[entry.category] || 0) + 1;
      return counts;
    }, {}));
    expect(categoryCounts).toHaveLength(10);
    expect(categoryCounts).toEqual(Array(10).fill(100));
  });

  it("responde ao health check pelo Worker", async () => {
    const response = await exports.default.fetch("https://forca.test/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      words: 1000,
      runtime: "cloudflare-workers"
    });
  });

  it("sincroniza uma sala, oculta a resposta, pontua e inicia a rodada seguinte", async () => {
    const { room, hostSession, guestSession, host, guest } = await createRoom();
    expect(host.playerId).toBeTruthy();
    expect(guest.room.players).toHaveLength(2);

    const started = await post(room, "/_action", {
      type: "start-game",
      sessionId: hostSession,
      playerId: host.playerId
    });
    expect(started.status).toBe(200);

    const snapshot = await runInDurableObject(room, (instance) => instance.snapshot());
    expect(snapshot.players).toHaveLength(2);
    expect(snapshot.round.answer).toBeNull();
    const secret = await runInDurableObject(
      room,
      (instance) => instance.room.round.word.word
    );
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    const firstGuess = await post(room, "/_action", {
      type: "guess",
      letter: "A",
      sessionId: hostSession,
      playerId: host.playerId
    });
    expect(firstGuess.status).toBe(200);
    const duplicate = await post(room, "/_action", {
      type: "guess",
      letter: "A",
      sessionId: hostSession,
      playerId: host.playerId
    });
    expect(duplicate.status).toBe(409);

    const letters = [...new Set(
      [...secret]
        .filter((letter) => /\p{L}/u.test(letter))
        .map((letter) => letter.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase())
    )];

    for (const letter of letters) {
      if (letter === "A") continue;
      const response = await post(room, "/_action", {
        type: "guess",
        letter,
        sessionId: hostSession,
        playerId: host.playerId
      });
      expect(response.status).toBe(200);
    }

    const completed = await runInDurableObject(room, (instance) => instance.snapshot());
    expect(completed.round.status).toBe("won");
    expect(completed.round.answer).toBe(secret);
    expect(completed.players.find(({ id }) => id === host.playerId).points).toBeGreaterThanOrEqual(100);
    const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const ranking = await post(directory, "/_ranking", {});
    expect(ranking.status).toBe(200);
    expect((await ranking.json()).players.map(({ name }) => name)).toContain("Jogador anfitrião");

    const next = await post(room, "/_action", {
      type: "next-round",
      sessionId: hostSession,
      playerId: host.playerId
    });
    expect(next.status).toBe(200);
    const nextState = await runInDurableObject(room, (instance) => instance.snapshot());
    expect(nextState.roundNumber).toBe(2);
    expect(nextState.round.status).toBe("playing");
  });

  it("impede que participantes controlem a sala ou alterem o placar", async () => {
    const { room, guest, guestSession } = await createRoom();
    const response = await post(room, "/_action", {
      type: "start-game",
      sessionId: guestSession,
      playerId: guest.playerId
    });
    expect(response.status).toBe(403);
  });
});
