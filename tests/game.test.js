const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { WORDS, CATEGORIES } = require("../wordbank");

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "forca-test-"));
process.env.FORCA_DATA_DIR = dataDirectory;
const { MAX_ERRORS, getRanking, normalizeLetter, rooms, selectWord, server } = require("../server");

test("o banco contém exatamente 1.000 palavras válidas e únicas em dez categorias", () => {
  assert.equal(WORDS.length, 1000);
  assert.equal(new Set(WORDS.map(({ word }) => word)).size, 1000);
  assert.equal(CATEGORIES.length, 10);
  assert.ok(WORDS.every(({ word, category, difficulty, hint }) =>
    word.length > 0 && CATEGORIES.includes(category) &&
    ["facil", "medio", "dificil"].includes(difficulty) && hint.length > 0
  ));
  for (const category of CATEGORIES) {
    assert.equal(WORDS.filter((entry) => entry.category === category).length, 100);
  }
});

test("acentos são normalizados sem aceitar entradas que não sejam uma letra", () => {
  assert.equal(normalizeLetter("á", true), "A");
  assert.equal(normalizeLetter("ç", true), "C");
  assert.equal(normalizeLetter("á", false), "Á");
  assert.equal(normalizeLetter("ab", true), null);
  assert.equal(normalizeLetter("1", true), null);
  assert.equal(MAX_ERRORS, 6);
});

test("uma sala não repete palavras antes de esgotar seu banco", () => {
  const samples = new Set();
  for (let count = 0; count < 30; count += 1) {
    samples.add(selectWord({ settings: { category: "Animais", difficulty: "" }, usedWords: new Set() }).word);
  }
  assert.ok(samples.size > 1, "a seleção deve variar entre partidas");

  const room = { settings: { category: "Animais", difficulty: "" }, usedWords: new Set() };
  for (let count = 0; count < 100; count += 1) {
    const word = selectWord(room);
    assert.equal(word.category, "Animais");
    assert.equal(room.usedWords.has(word.word), true);
    assert.equal(room.usedWords.size, count + 1);
  }
  const previous = new Set(room.usedWords);
  const next = selectWord(room);
  assert.equal(room.usedWords.size, 1);
  assert.ok(previous.has(next.word));
});

function waitForMessage(socket, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Tempo esgotado aguardando mensagem ${type}.`));
    }, timeout);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== type && !(type === "room-update" && ["state", "round-won"].includes(message.type))) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

function send(socket, type, data = {}) {
  socket.send(JSON.stringify({ type, ...data }));
}

test("dois jogadores sincronizam palpites, pontuam e iniciam uma nova rodada", async (t) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.readyState === WebSocket.OPEN && socket.close());
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  const address = server.address();
  const url = `ws://127.0.0.1:${address.port}`;
  const connect = async () => {
    const socket = new WebSocket(url);
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return socket;
  };
  const host = await connect();
  const joinedHost = waitForMessage(host, "joined");
  send(host, "create-room", { name: "Ana", settings: { rounds: 2, maxPlayers: 4 } });
  const hostRoom = await joinedHost;
  const guest = await connect();
  const joinedGuest = waitForMessage(guest, "joined");
  send(guest, "join-room", { name: "Bia", code: hostRoom.room.code });
  await joinedGuest;

  const hostStarted = waitForMessage(host, "state");
  const guestStarted = waitForMessage(guest, "state");
  send(host, "start-game");
  const [hostState, guestState] = await Promise.all([hostStarted, guestStarted]);
  const room = rooms.get(hostRoom.room.code);
  const answer = room.round.word.word;
  assert.equal(JSON.stringify(hostState.room).includes(answer), false);
  assert.deepEqual(hostState.room.round.guessed, guestState.room.round.guessed);

  const letters = [...new Set([...answer]
    .map((letter) => normalizeLetter(letter, true))
    .filter((letter) => /^[A-Z]$/.test(letter)))];
  const firstGuessHost = waitForMessage(host, "room-update");
  const firstGuessGuest = waitForMessage(guest, "room-update");
  send(host, "guess", { letter: letters[0] });
  const [firstHostState, firstGuestState] = await Promise.all([firstGuessHost, firstGuessGuest]);
  assert.deepEqual(firstHostState.room.round.guessed, firstGuestState.room.round.guessed);

  const duplicateError = waitForMessage(host, "error");
  send(host, "guess", { letter: letters[0] });
  assert.match((await duplicateError).message, /já foi escolhida/);

  let finalMessage = firstHostState;
  for (const letter of letters.slice(1)) {
    const hostUpdate = waitForMessage(host, "room-update");
    const guestUpdate = waitForMessage(guest, "room-update");
    send(host, "guess", { letter });
    const [hostUpdateMessage, guestUpdateMessage] = await Promise.all([hostUpdate, guestUpdate]);
    assert.deepEqual(hostUpdateMessage.room.round.guessed, guestUpdateMessage.room.round.guessed);
    finalMessage = hostUpdateMessage;
  }
  if (finalMessage.room.round.status !== "won") {
    const completion = waitForMessage(host, "round-won");
    for (const letter of letters) {
      if (room.round.status !== "playing") break;
      const update = waitForMessage(host, "room-update");
      send(host, "guess", { letter });
      await Promise.race([update, completion]);
    }
    finalMessage = await completion;
  }
  assert.equal(finalMessage.room.round.status, "won");
  assert.equal(finalMessage.room.round.answer, answer);
  assert.ok(finalMessage.room.players.find((player) => player.id === hostRoom.playerId).points >= 100);

  const nextHostRound = waitForMessage(host, "state");
  const nextGuestRound = waitForMessage(guest, "state");
  send(host, "next-round");
  const [nextHost, nextGuest] = await Promise.all([nextHostRound, nextGuestRound]);
  assert.equal(nextHost.room.round.roundNumber, 2);
  assert.notEqual(rooms.get(hostRoom.room.code).round.word.word, answer);
  assert.deepEqual(nextHost.room.round.guessed, nextGuest.room.round.guessed);
  assert.ok(getRanking().some((player) => player.name === "Ana" && player.wordsFound === 1));
});
