import { env, exports } from "cloudflare:workers";
import { reset, runInDurableObject, runInDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { WORDS } from "../shared.js";

async function post(stub, path, body) {
  return stub.fetch(`https://test.forca${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function createRoom(names = ["Anfitrião", "Convidado"], settings = {}) {
  const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
  const allocation = await post(directory, "/_allocate", {});
  const { code } = await allocation.json();
  const room = env.ROOMS.get(env.ROOMS.idFromName(code));
  const players = [];
  for (let index = 0; index < names.length; index += 1) {
    const sessionId = env.SESSIONS.newUniqueId().toString();
    const response = index === 0
      ? await post(room, "/_create", {
        code,
        sessionId,
        name: names[index],
        settings: { ...settings, rounds: settings.rounds ?? 1, timeLimit: settings.timeLimit ?? 60 }
      })
      : await post(room, "/_join", { code, sessionId, name: names[index] });
    expect(response.status).toBe(200);
    players.push({ ...(await response.json()), sessionId, name: names[index] });
  }
  return { room, code, players };
}

async function startRoom(room, players) {
  for (const player of players) {
    if (!player.room?.players?.find((entry) => entry.id === player.playerId)?.ready) {
      await post(room, "/_action", {
        type: "ready-toggle",
        sessionId: player.sessionId,
        playerId: player.playerId,
        ready: true
      });
    }
  }
  return post(room, "/_action", {
    type: "start-game",
    sessionId: players[0].sessionId,
    playerId: players[0].playerId
  });
}

async function guess(room, player, letter) {
  return post(room, "/_action", {
    type: "guess",
    letter,
    sessionId: player.sessionId,
    playerId: player.playerId
  });
}

async function solve(room, player, answer) {
  const letters = [...new Set([...answer]
    .filter((letter) => /\p{L}/u.test(letter))
    .map((letter) => letter.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase()))];
  for (const letter of letters) {
    const state = await runInDurableObject(room, (instance) => instance.room.round.progress[player.playerId]);
    if (state.status !== "playing") break;
    await guess(room, player, letter);
  }
}

function getResponseWebSocket(response) {
  if (!response.webSocket) throw new TypeError("Esperava uma resposta WebSocket.");
  return response.webSocket;
}

function waitForSocketMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Tempo esgotado aguardando uma mensagem WebSocket."));
    }, 10_000);
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("Erro no WebSocket durante o teste."));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}

async function connectSession() {
  const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
  const response = await stub.fetch("https://test.forca/socket", {
    headers: { Upgrade: "websocket" }
  });
  const socket = getResponseWebSocket(response);
  socket.accept();
  return { stub, socket };
}

describe("Multiplayer competitivo em Cloudflare Workers", () => {
  afterEach(async () => reset());

  it("preserva o banco com 1.000 palavras únicas e dez categorias", () => {
    expect(WORDS).toHaveLength(1000);
    expect(new Set(WORDS.map(({ word }) => word.toLocaleLowerCase("pt-BR"))).size).toBe(1000);
    expect(new Set(WORDS.map(({ category }) => category)).size).toBe(10);
  });

  it("entrega o health check do Worker", async () => {
    const health = await exports.default.fetch("https://forca.test/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      words: 1000,
      runtime: "cloudflare-workers"
    });
  });

  it("lista salas públicas e exige dois jogadores para iniciar", async () => {
    const publicRoom = await createRoom(["Anfitriã"], { isPublic: true });
    const privateRoom = await createRoom(["Reservada"], { isPublic: false });
    const start = await post(publicRoom.room, "/_action", {
      type: "start-game",
      sessionId: publicRoom.players[0].sessionId,
      playerId: publicRoom.players[0].playerId
    });
    expect(start.status).toBe(409);
    const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const listing = await (await post(directory, "/_public-rooms", {})).json();
    expect(listing.rooms.map(({ code }) => code)).toContain(publicRoom.code);
    expect(listing.rooms.map(({ code }) => code)).not.toContain(privateRoom.code);
  });

  it("sincroniza palpites por WebSocket sem compartilhar o progresso individual", async () => {
    const host = await connectSession();
    let guest;
    try {
      const hostJoinedPromise = waitForSocketMessage(host.socket, (message) => message.type === "joined");
      host.socket.send(JSON.stringify({ type: "create-room", name: "Ana", settings: { rounds: 2, timeLimit: 0 } }));
      const hostJoined = await hostJoinedPromise;
      guest = await connectSession();
      const guestJoinedPromise = waitForSocketMessage(guest.socket, (message) => message.type === "joined");
      const hostLobbyPromise = waitForSocketMessage(
        host.socket,
        (message) => message.type === "state" && message.room.players.length === 2
      );
      guest.socket.send(JSON.stringify({
        type: "join-room",
        code: hostJoined.room.code,
        name: "Bia"
      }));
      const [guestJoined] = await Promise.all([guestJoinedPromise, hostLobbyPromise]);
      expect(guestJoined.room.players).toHaveLength(2);

      const readyState = (message) =>
        message.type === "state" && message.room.players.length === 2 && message.room.players.every((player) => player.ready);
      const hostReadyPromise = waitForSocketMessage(host.socket, readyState);
      const guestReadyPromise = waitForSocketMessage(guest.socket, readyState);
      guest.socket.send(JSON.stringify({ type: "ready-toggle", ready: true }));
      await Promise.all([hostReadyPromise, guestReadyPromise]);

      const playingState = (message) => message.type === "state" && message.room.status === "playing";
      const hostPlayingPromise = waitForSocketMessage(host.socket, playingState);
      const guestPlayingPromise = waitForSocketMessage(guest.socket, playingState);
      host.socket.send(JSON.stringify({ type: "start-game" }));
      await Promise.all([hostPlayingPromise, guestPlayingPromise]);

      const room = env.ROOMS.get(env.ROOMS.idFromName(hostJoined.room.code));
      const answer = await runInDurableObject(room, (instance) => instance.room.round.word.word);
      const answerLetters = new Set([...answer]
        .filter((letter) => /\p{L}/u.test(letter))
        .map((letter) => letter.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase()));
      const correct = [...answerLetters][0];
      const wrong = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].find((letter) => !answerLetters.has(letter));

      const hostGuessPromise = waitForSocketMessage(
        host.socket,
        (message) => message.type === "state" && message.room.round.guessed.includes(wrong)
      );
      const guestUnchangedPromise = waitForSocketMessage(
        guest.socket,
        (message) => message.type === "state" && message.room.round.guessed.length === 0
      );
      host.socket.send(JSON.stringify({ type: "guess", letter: wrong }));
      const [hostAfterGuess, guestAfterHostGuess] = await Promise.all([hostGuessPromise, guestUnchangedPromise]);
      expect(hostAfterGuess.room.round.mistakes).toBe(1);
      expect(guestAfterHostGuess.room.round.mistakes).toBe(0);

      const guestGuessPromise = waitForSocketMessage(
        guest.socket,
        (message) => message.type === "state" && message.room.round.guessed.includes(correct)
      );
      const hostUnchangedPromise = waitForSocketMessage(
        host.socket,
        (message) => message.type === "state" &&
          message.room.round.guessed.includes(wrong) && !message.room.round.guessed.includes(correct)
      );
      guest.socket.send(JSON.stringify({ type: "guess", letter: correct }));
      const [guestAfterGuess, hostAfterGuestGuess] = await Promise.all([guestGuessPromise, hostUnchangedPromise]);
      expect(guestAfterGuess.room.round.guessed).toContain(correct);
      expect(hostAfterGuestGuess.room.round.guessed).toEqual([wrong]);
      expect(guestAfterGuess.room.round.answer).toBeNull();
      expect(guestAfterGuess.room.round).not.toHaveProperty("word");
    } finally {
      guest?.socket.close(1000, "fim do teste");
      host.socket.close(1000, "fim do teste");
    }
  });

  it("admite oito jogadores e mantém duas partidas simultâneas em objetos separados", async () => {
    const first = await createRoom(Array.from({ length: 8 }, (_, index) => `Pessoa ${index + 1}`));
    const second = await createRoom(["Outra anfitriã", "Outro jogador"]);
    expect(first.players).toHaveLength(8);
    expect(second.players).toHaveLength(2);
    expect(first.code).not.toBe(second.code);
    const starts = await Promise.all([
      startRoom(first.room, first.players),
      startRoom(second.room, second.players)
    ]);
    expect(starts.map((response) => response.status)).toEqual([200, 200]);
    const firstSnapshot = await runInDurableObject(first.room, (instance) => instance.snapshot());
    const secondSnapshot = await runInDurableObject(second.room, (instance) => instance.snapshot());
    expect(firstSnapshot.players).toHaveLength(8);
    expect(secondSnapshot.players).toHaveLength(2);
    expect(firstSnapshot.status).toBe("playing");
    expect(secondSnapshot.status).toBe("playing");
    expect(firstSnapshot.code).not.toBe(secondSnapshot.code);
  });

  it("mantém progresso e tentativas separados para cada participante", async () => {
    const { room, players } = await createRoom();
    expect((await startRoom(room, players)).status).toBe(200);
    const answer = await runInDurableObject(room, (instance) => instance.room.round.word.word);
    const firstLetter = [...answer].find((letter) => /\p{L}/u.test(letter))
      .normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase();
    expect((await guess(room, players[0], firstLetter)).status).toBe(200);
    const hostState = await runInDurableObject(room, (instance) => instance.snapshot(players[0].playerId));
    const guestState = await runInDurableObject(room, (instance) => instance.snapshot(players[1].playerId));
    expect(hostState.round.guessed).toContain(firstLetter);
    expect(guestState.round.guessed).not.toContain(firstLetter);
    expect(hostState.round.mistakes).toBe(0);
    expect(guestState.round.mistakes).toBe(0);
    expect(guestState.round.answer).toBeNull();
    expect(guestState.round).not.toHaveProperty("word");
  });

  it("aplica a pontuação exata, a sequência e os critérios de desempate no servidor", async () => {
    const { room, players } = await createRoom(["Ana", "Bia"], {
      rounds: 3,
      timeLimit: 0,
      speedEnabled: false
    });
    expect((await startRoom(room, players)).status).toBe(200);
    const usedWords = new Set();
    for (const [index, expectedPoints] of [130, 260, 415].entries()) {
      const answer = await runInDurableObject(room, (instance) => instance.room.round.word.word);
      expect(usedWords.has(answer)).toBe(false);
      usedWords.add(answer);
      await solve(room, players[0], answer);
      await solve(room, players[1], answer);
      const afterWin = await runInDurableObject(room, (instance) => instance.snapshot(players[0].playerId));
      expect(afterWin.players.find(({ id }) => id === players[0].playerId).points).toBe(expectedPoints);
      expect(afterWin.players.find(({ id }) => id === players[0].playerId).roundsPlayed).toBe(index + 1);
      expect(afterWin.round.status).toBe("won");
      expect(afterWin.round.winnerId).toBe(players[0].playerId);
      if (index < 2) {
        expect((await post(room, "/_action", {
          type: "next-round",
          sessionId: players[0].sessionId,
          playerId: players[0].playerId
        })).status).toBe(200);
      }
    }

    await runInDurableObject(room, async (instance) => {
      const [a, b] = instance.room.players;
      a.points = 500;
      a.errors = 3;
      a.timeSpentMs = 10000;
      a.wordsFound = 2;
      b.points = 500;
      b.errors = 2;
      b.timeSpentMs = 20000;
      const ranked = instance.snapshot(players[0].playerId).players;
      expect(ranked[0].id).toBe(b.id);
      b.errors = 3;
      b.timeSpentMs = 9000;
      b.wordsFound = 3;
      expect(instance.snapshot(players[0].playerId).players[0].id).toBe(b.id);
      b.timeSpentMs = 10000;
      expect(instance.snapshot(players[0].playerId).players[0].id).toBe(b.id);
      b.wordsFound = 1;
      expect(instance.snapshot(players[0].playerId).players[0].id).toBe(a.id);
    });
  });

  it("retoma a sessão sem duplicar o jogador e remove participantes expirados", async () => {
    const { room, code, players } = await createRoom();
    expect((await startRoom(room, players)).status).toBe(200);
    expect((await guess(room, players[1], "A")).status).toBe(200);
    const guessedBeforeResume = await runInDurableObject(
      room,
      (instance) => instance.room.round.progress[players[1].playerId].guessed
    );
    const replacementSession = env.SESSIONS.newUniqueId().toString();
    const resumed = await post(room, "/_resume", {
      code,
      token: players[1].token,
      sessionId: replacementSession
    });
    expect(resumed.status).toBe(200);
    const resumedState = await resumed.json();
    expect(resumedState.playerId).toBe(players[1].playerId);
    expect(resumedState.room.players).toHaveLength(2);
    expect(resumedState.room.round.guessed).toEqual(guessedBeforeResume);

    await post(room, "/_disconnect", {
      playerId: players[1].playerId,
      sessionId: replacementSession
    });
    await runInDurableObject(room, async (instance) => {
      const player = instance.room.players.find(({ id }) => id === players[1].playerId);
      player.disconnectedAt = Date.now() - 61_000;
      await instance.persist();
      await instance.syncAlarm();
    });
    expect((await post(room, "/_resume", {
      code,
      token: players[1].token,
      sessionId: env.SESSIONS.newUniqueId().toString()
    })).status).toBe(410);
    expect(await runInDurableObjectAlarm(room)).toBe(true);
    const afterExpire = await runInDurableObject(room, (instance) => instance.snapshot());
    expect(afterExpire.players).toHaveLength(1);
  });

  it("encerra a rodada pelo alarme e só então revela a palavra aos demais", async () => {
    const { room, players } = await createRoom(["Ana", "Bia"], { rounds: 1, timeLimit: 60 });
    expect((await startRoom(room, players)).status).toBe(200);
    const answer = await runInDurableObject(room, (instance) => instance.room.round.word.word);
    const before = await runInDurableObject(room, (instance) => instance.snapshot(players[1].playerId));
    expect(before.round.answer).toBeNull();
    await runInDurableObject(room, async (instance) => {
      instance.room.round.deadline = Date.now() - 1;
      await instance.persist();
      await instance.syncAlarm();
    });
    expect(await runInDurableObjectAlarm(room)).toBe(true);
    const after = await runInDurableObject(room, (instance) => instance.snapshot(players[1].playerId));
    expect(after.round.answer).toBe(answer);
    expect(after.round.status).toBe("lost");
    expect(after.status).toBe("finished");
  });

  it("grava ranking geral e semanal no D1 e impede duplicar resultados", async () => {
    const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const result = {
      matchId: crypto.randomUUID(),
      championId: "ana",
      endedAt: Date.now(),
      roomCode: "ABC123",
      players: [{
        id: "ana",
        name: "Ana",
        points: 150,
        errors: 2,
        timeSpentMs: 12000,
        wordsFound: 1,
        roundsPlayed: 1,
        bestStreak: 1
      }]
    };
    expect((await post(directory, "/_record-match", result)).status).toBe(200);
    expect((await post(directory, "/_record-match", result)).status).toBe(200);
    const general = await (await post(directory, "/_ranking", {})).json();
    const weekly = await (await post(directory, "/_ranking", { period: "weekly" })).json();
    expect(general.players[0]).toMatchObject({ name: "Ana", games: 1, wins: 1, points: 150, wordsFound: 1 });
    expect(weekly.players[0]).toMatchObject({ name: "Ana", games: 1, points: 150 });
  });

  it("bloqueia controles de anfitrião, tentativas duplicadas e mensagens inválidas", async () => {
    const { room, players } = await createRoom();
    expect((await startRoom(room, players)).status).toBe(200);
    expect((await post(room, "/_action", {
      type: "end-game",
      sessionId: players[1].sessionId,
      playerId: players[1].playerId
    })).status).toBe(403);
    const answer = await runInDurableObject(room, (instance) => instance.room.round.word.word);
    const letter = [...answer].find((char) => /\p{L}/u.test(char))
      .normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase();
    expect((await guess(room, players[0], letter)).status).toBe(200);
    expect((await guess(room, players[0], letter)).status).toBe(409);
    expect((await post(room, "/_action", {
      type: "chat",
      message: "x".repeat(201),
      sessionId: players[0].sessionId,
      playerId: players[0].playerId
    })).status).toBe(400);
    for (let index = 0; index < 5; index += 1) {
      expect((await post(room, "/_action", {
        type: "chat",
        message: `Mensagem ${index}`,
        sessionId: players[0].sessionId,
        playerId: players[0].playerId
      })).status).toBe(200);
    }
    expect((await post(room, "/_action", {
      type: "chat",
      message: "Limite excedido",
      sessionId: players[0].sessionId,
      playerId: players[0].playerId
    })).status).toBe(429);
  });
});
