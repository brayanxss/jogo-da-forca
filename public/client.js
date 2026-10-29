(() => {
  const $ = (selector) => document.querySelector(selector);
  const els = {
    home: $("#home-screen"), gameScreen: $("#game-screen"), multiplayerPanel: $("#multiplayer-panel"),
    setupDialog: $("#setup-dialog"), rankingDialog: $("#ranking-dialog"), toast: $("#toast"),
    connection: $("#connection-status"), name: $("#player-name"), roomCode: $("#room-code-input"),
    homeName: $("#home-player-name"),
    codeField: $("#code-field"), nameField: $("#name-field"), soloCategoryField: $("#solo-category-field"),
    soloDifficultyField: $("#solo-difficulty-field"), createSettings: $("#create-settings"),
    dialogTitle: $("#dialog-title"), dialogDescription: $("#dialog-description"), dialogEyebrow: $("#dialog-eyebrow"),
    dialogSubmit: $("#dialog-submit"), lobby: $("#lobby-panel"), playArea: $("#play-area"),
    lobbyList: $("#lobby-player-list"), lobbyCount: $("#lobby-player-count"),
    startGame: $("#start-game-button"), keyboard: $("#keyboard"), maskedWord: $("#masked-word"),
    feedback: $("#feedback-banner"), scoreList: $("#score-list"), rankingList: $("#ranking-list"),
    gameTitle: $("#game-title"), gameMode: $("#game-mode-label"), roomCodeBox: $("#room-code-box"),
    category: $("#round-category"), counter: $("#round-counter"), timer: $("#round-timer"),
    tries: $("#tries-label"), hangman: $("#hangman"), hint: $("#hint-button"),
    next: $("#next-round-button"), playAgain: $("#play-again-button"), endGame: $("#end-game-button"),
    pause: $("#pause-game-button"),
    finished: $("#game-finished"), finishedCopy: $("#finished-copy")
  };

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const accentedAlphabet = [..."AÁÀÂÃBCÇDEÉÊFGHIÍJKLMNOÓÔÕPQRSTUVWXYZÚÜ"];
  const categoryNames = ["Animais", "Alimentos", "Profissões", "Esportes", "Tecnologia", "Natureza", "Objetos", "Lugares", "Cinema", "Geral"];
  const avatarColors = ["#d9b084", "#92bdd0", "#aa9add", "#85c7a8", "#db93a0", "#e0b370"];
  let socket;
  let reconnectDelay = 1000;
  let reconnectTimer;
  let currentMode = null;
  let dialogAction = null;
  let currentPlayerId = null;
  let roomState = null;
  let soloState = null;
  let soloPlayerName = "";
  let soloGameId = null;
  let soloTotalPoints = 0;
  let lastGuess = null;
  let toastTimer;
  let clockTimer;
  let soundEnabled = false;
  let audioContext;

  function showToast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.classList.toggle("error", isError);
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2800);
  }

  function playTone(success = true) {
    if (!soundEnabled) return;
    try {
      audioContext ||= new AudioContext();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = success ? 620 : 230;
      gain.gain.setValueAtTime(.035, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .12);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + .12);
    } catch (error) {
      console.warn("Não foi possível reproduzir o som.", error);
    }
  }

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}`);
    socket.addEventListener("open", () => {
      reconnectDelay = 1000;
      els.connection.className = "connection connected";
      els.connection.innerHTML = "<i></i> Conectado";
      let saved;
      try {
        saved = JSON.parse(sessionStorage.getItem("forca-session") || "null");
      } catch {
        sessionStorage.removeItem("forca-session");
      }
      if (saved?.code && saved?.token) {
        socket.send(JSON.stringify({ type: "resume-room", ...saved }));
      }
      send("ranking");
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        showToast("Recebemos uma resposta inválida do servidor.", true);
        return;
      }
      handleMessage(message);
    });
    socket.addEventListener("close", () => {
      els.connection.className = "connection disconnected";
      els.connection.innerHTML = "<i></i> Reconectando";
      if (currentMode === "solo") showToast("Conexão perdida. Sua partida solo foi desconectada.", true);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(12000, reconnectDelay * 1.8);
    });
    socket.addEventListener("error", () => socket.close());
  }

  function send(type, data = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      showToast("Sem conexão com o servidor. Tentando reconectar…", true);
      return false;
    }
    socket.send(JSON.stringify({ type, ...data }));
    return true;
  }

  function handleMessage(message) {
    if (message.type === "error") {
      if (message.message?.includes("retomar")) sessionStorage.removeItem("forca-session");
      return showToast(message.message || "Algo deu errado.", true);
    }
    if (message.type === "joined") {
      currentMode = "room";
      currentPlayerId = message.playerId;
      roomState = message.room;
      if (message.token) sessionStorage.setItem("forca-session", JSON.stringify({ code: message.room.code, token: message.token }));
      updateProfile(message.room.players.find((player) => player.id === currentPlayerId)?.name);
      showGameScreen();
      renderRoom();
      showToast("Você entrou na sala. Boa partida!");
      return;
    }
    if (message.type === "state" || message.type === "round-won" || message.type === "round-lost" || message.type === "game-finished") {
      if (!roomState) return;
      roomState = message.room;
      if (message.type === "round-won") {
        playTone(true);
        const winner = roomState.players.find((player) => player.id === roomState.round?.winnerId);
        if (winner) showToast(`${winner.name} descobriu a palavra! ✨`);
      } else if (message.type === "round-lost") {
        playTone(false);
        showToast(`A palavra era “${roomState.round?.answer}”.`, true);
      }
      renderRoom();
      return;
    }
    if (message.type === "solo-state") {
      currentMode = "solo";
      if (message.gameId !== soloGameId) {
        soloGameId = message.gameId;
        soloTotalPoints = 0;
      }
      soloTotalPoints += message.points || 0;
      soloState = message.game;
      if (message.gameId) sessionStorage.setItem("forca-solo-id", message.gameId);
      if (message.points) showToast(`Você marcou ${message.points} pontos! ✨`);
      if (lastGuess && soloState.guessed.includes(lastGuess)) playTone(soloState.status === "playing" || soloState.status === "won");
      lastGuess = null;
      showGameScreen();
      renderSolo();
      return;
    }
    if (message.type === "ranking") {
      renderRanking(message.players || [], message.stats);
      return;
    }
    if (message.type === "public-rooms") {
      renderPublicRooms(message.rooms || []);
    }
  }

  function showHome() {
    if (currentMode === "room") send("leave-room");
    if (currentMode === "solo") send("leave-solo");
    els.home.hidden = false;
    els.gameScreen.hidden = true;
    els.multiplayerPanel.hidden = true;
    roomState = null;
    soloState = null;
    currentMode = null;
    currentPlayerId = null;
    sessionStorage.removeItem("forca-session");
    sessionStorage.removeItem("forca-solo-id");
    clearInterval(clockTimer);
    send("ranking");
  }

  function showGameScreen() {
    els.home.hidden = true;
    els.gameScreen.hidden = false;
  }

  function openSetup(action) {
    dialogAction = action;
    const isSolo = action === "solo";
    const isCreate = action === "create";
    const isJoin = action === "join";
    els.dialogEyebrow.textContent = isSolo ? "MODO SOLO" : isCreate ? "NOVA SALA" : "ENTRAR NA PARTIDA";
    els.dialogTitle.textContent = isSolo ? "Um desafio só seu." : isCreate ? "Vamos montar a sala?" : "Qual é o código da sala?";
    els.dialogDescription.textContent = isSolo
      ? "Escolha uma categoria e descubra a palavra antes que as tentativas acabem."
      : isCreate ? "Personalize o começo da partida e convide seus amigos."
        : "Digite o código de seis caracteres compartilhado pelo anfitrião.";
    els.nameField.hidden = false;
    els.codeField.hidden = !isJoin;
    els.soloCategoryField.hidden = !isSolo;
    els.soloDifficultyField.hidden = !isSolo;
    els.createSettings.hidden = !isCreate;
    els.name.value = els.homeName.value.trim() || localStorage.getItem("forca-name") || "";
    els.roomCode.value = "";
    els.roomCode.required = isJoin;
    setTimeout(() => (isJoin ? els.roomCode : els.name).focus(), 50);
    els.setupDialog.showModal();
  }

  function buildRoomSettings() {
    return {
      category: $("#create-category").value,
      format: $("#create-format").value,
      maxPlayers: Number($("#create-max").value),
      isPublic: $("#create-public").checked
    };
  }

  function readLobbySettings() {
    return {
      category: $("#setting-category").value,
      difficulty: $("#setting-difficulty").value,
      format: $("#setting-format").value,
      maxPlayers: Number($("#setting-players").value),
      rounds: Number($("#setting-rounds").value),
      timeLimit: Number($("#setting-time").value),
      pointsPerWord: Number($("#setting-points").value),
      perfectBonus: Number($("#setting-perfect").value),
      speedBonus: Number($("#setting-speed-points").value),
      speedEnabled: $("#setting-speed").checked,
      speedThreshold: Number($("#setting-speed-threshold").value),
      errorPenalty: Number($("#setting-penalty").value),
      isPublic: $("#setting-public").checked,
      hints: $("#setting-hints").checked,
      ignoreAccents: $("#setting-accents").checked
    };
  }

  function populateCategorySelect(select) {
    select.replaceChildren(new Option("Aleatória", ""));
    categoryNames.forEach((name) => select.add(new Option(name, name)));
  }

  function updateProfile(name) {
    if (!name) return;
    localStorage.setItem("forca-name", name);
    $("#profile-name").textContent = name;
    $("#avatar-letter").textContent = [...name][0].toLocaleUpperCase("pt-BR");
  }

  function initialsColor(index) {
    return avatarColors[index % avatarColors.length];
  }

  function renderRoom() {
    if (!roomState) return;
    $("#room-code-label").textContent = roomState.code;
    els.roomCodeBox.hidden = false;
    $("#score-rule").innerHTML = `${roomState.settings.pointsPerWord} pontos por palavra descoberta<br><small>Bônus de ${roomState.settings.perfectBonus} pontos sem erros</small>`;
    const isHost = roomState.players.some((player) => player.id === currentPlayerId && player.host);
    if (roomState.status === "lobby") {
      els.lobby.hidden = false;
      els.playArea.hidden = true;
      els.finished.hidden = true;
      els.gameTitle.textContent = "Sala de espera";
      els.gameMode.textContent = "MULTIPLAYER";
      renderLobby(isHost);
      return;
    }
    els.lobby.hidden = true;
    if (roomState.status === "finished") {
      els.playArea.hidden = true;
      els.finished.hidden = false;
      els.gameTitle.textContent = "Partida concluída";
      const winner = [...roomState.players].sort((a, b) => b.points - a.points || b.wordsFound - a.wordsFound || a.errors - b.errors)[0];
      els.finishedCopy.textContent = winner ? `${winner.name} terminou na frente, com ${winner.points} pontos. Valeu por jogar!` : "A partida chegou ao fim.";
      return;
    }
    els.finished.hidden = true;
    els.playArea.hidden = false;
    els.gameTitle.textContent = roomState.status === "paused" ? "Partida pausada" : "Hora de adivinhar";
    els.gameMode.textContent = roomState.format === "turns" ? "COMPETIÇÃO POR TURNOS" : "TODOS CONTRA A PALAVRA";
    $("#end-game-button").hidden = !isHost;
    renderRound(roomState.round, roomState);
  }

  function renderLobby(isHost) {
    const settings = roomState.settings;
    $("#lobby-player-count").textContent = `${roomState.players.length}/${settings.maxPlayers}`;
    $("#lobby-player-list").replaceChildren(...roomState.players.map((player, index) => {
      const row = document.createElement("div");
      row.className = "lobby-player";
      const avatar = document.createElement("span");
      avatar.className = "player-avatar";
      avatar.style.background = initialsColor(index);
      avatar.textContent = [...player.name][0].toLocaleUpperCase("pt-BR");
      const name = document.createElement("span");
      name.textContent = player.name;
      row.append(avatar, name);
      if (player.host) {
        const host = document.createElement("span");
        host.className = "host-tag";
        host.textContent = "ANFITRIÃO";
        row.append(host);
      }
      if (!player.connected) {
        const status = document.createElement("span");
        status.className = "connection-label";
        status.textContent = "Reconectando…";
        row.append(status);
      }
      return row;
    }));
    const controls = ["category", "difficulty", "format", "players", "rounds", "time", "points", "perfect", "speed-points", "speed-threshold", "penalty", "public", "hints", "speed", "accents"];
    const values = [settings.category, settings.difficulty, settings.format, String(settings.maxPlayers), String(settings.rounds), String(settings.timeLimit), String(settings.pointsPerWord), String(settings.perfectBonus), String(settings.speedBonus), String(settings.speedThreshold), String(settings.errorPenalty)];
    controls.slice(0, 11).forEach((key, index) => {
      const control = $(`#setting-${key}`);
      if (document.activeElement !== control) control.value = values[index];
    });
    $("#setting-public").checked = settings.isPublic;
    $("#setting-hints").checked = settings.hints;
    $("#setting-speed").checked = settings.speedEnabled;
    $("#setting-accents").checked = settings.ignoreAccents;
    ["category", "difficulty", "format", "players", "rounds", "time", "points", "perfect", "speed-points", "speed-threshold", "penalty", "public", "hints", "speed", "accents"].forEach((key) => {
      $(`#setting-${key}`).disabled = !isHost;
    });
    els.startGame.disabled = !isHost || roomState.players.length < 2;
    els.startGame.innerHTML = roomState.players.length < 2 ? "Aguardando mais jogadores…" : "Iniciar partida <span>↗</span>";
    $("#lobby-help").textContent = isHost ? "Suas opções são aplicadas a todas as rodadas." : "O anfitrião escolherá as opções e iniciará o jogo.";
  }

  function currentRound() {
    return currentMode === "room" ? roomState?.round : soloState;
  }

  function renderRound(round, state) {
    if (!round) return;
    els.category.textContent = (round.category || "Geral").toLocaleUpperCase("pt-BR");
    els.counter.textContent = currentMode === "room"
      ? `RODADA ${round.roundNumber} / ${state.roundsTotal}`
      : "RODADA SOLO";
    els.hangman.dataset.errors = String(round.mistakes);
    els.tries.textContent = `${Math.max(0, round.maxErrors - round.mistakes)} ${round.maxErrors - round.mistakes === 1 ? "tentativa restante" : "tentativas restantes"}`;
    renderMaskedWord(round);
    renderKeyboard(round);
    if (round.hint) {
      $("#word-caption").textContent = `Dica: ${round.hint}`;
    } else {
      $("#word-caption").textContent = round.status === "playing"
        ? "Descubra a palavra antes que as tentativas acabem."
        : round.status === "won" ? "Mandou muito bem! Palavra descoberta." : "Fim de jogo. Vamos para a próxima?";
    }
    els.feedback.hidden = round.status === "playing";
    els.feedback.classList.toggle("lost", round.status === "lost");
    if (round.status === "won") {
      const winner = state?.players?.find((player) => player.id === round.winnerId);
      els.feedback.textContent = currentMode === "solo" ? `Você acertou: ${round.answer}! 🎉` : `${winner?.name || "Alguém"} descobriu: ${round.answer}! 🎉`;
    } else if (round.status === "lost") {
      els.feedback.textContent = round.endReason === "timeout"
        ? `O tempo acabou. A palavra era ${round.answer}.`
        : round.endReason === "ended"
          ? `A partida foi encerrada. A palavra era ${round.answer}.`
          : `As tentativas acabaram. A palavra era ${round.answer}.`;
    } else {
      els.feedback.textContent = "";
    }
    const isHost = currentMode === "room" && state.players.some((player) => player.id === currentPlayerId && player.host);
    const canNext = round.status !== "playing" && currentMode === "room" && isHost && round.roundNumber < state.roundsTotal;
    els.next.hidden = !canNext;
    els.playAgain.hidden = !(round.status !== "playing" && currentMode === "solo");
    els.pause.hidden = !isHost || (round.status !== "playing" && state?.status !== "paused");
    els.pause.textContent = state?.status === "paused" ? "Retomar" : "Pausar";
    els.hint.hidden = round.status !== "playing" || (currentMode === "room" && !state.settings.hints);
    els.hint.disabled = Boolean(round.hint) || round.status !== "playing" || state?.status === "paused";
    const currentTurn = state?.turnPlayerId;
    const turnIsMine = currentMode !== "room" || state.format !== "turns" || currentTurn === currentPlayerId;
    els.keyboard.querySelectorAll("button").forEach((key) => {
      if (round.status !== "playing" || !turnIsMine || state?.status === "paused") key.disabled = true;
    });
    $("#word-caption").classList.toggle("turn-caption", !turnIsMine);
    $(".accent-note").textContent = round.ignoreAccents ? "Acentos são ignorados" : "Acentos são diferenciados";
    if (!turnIsMine && round.status === "playing") $("#word-caption").textContent = `Vez de ${state.players.find((player) => player.id === currentTurn)?.name || "outro jogador"}.`;
    if (currentMode === "room") renderScoreboard(state, currentIdFromWinner(round));
    else renderSoloScore();
    updateTimer(round);
  }

  function currentIdFromWinner(round) {
    return round.winnerId || "";
  }

  function renderMaskedWord(round) {
    els.maskedWord.replaceChildren(...round.masked.map((letter, index) => {
      if (letter === " ") {
        const spacer = document.createElement("span");
        spacer.className = "letter-space";
        return spacer;
      }
      if (!/\p{L}/u.test(round.masked[index] || "")) {
        const punctuation = document.createElement("span");
        punctuation.className = "letter-punctuation";
        punctuation.textContent = round.masked[index] || "";
        return punctuation;
      }
      const slot = document.createElement("span");
      slot.className = "letter-slot";
      if (letter) {
        slot.classList.add("revealed");
        slot.textContent = letter.toLocaleUpperCase("pt-BR");
      }
      return slot;
    }));
  }

  function renderKeyboard(round) {
    const keys = round.ignoreAccents === false ? accentedAlphabet : alphabet;
    els.keyboard.replaceChildren(...keys.map((letter) => {
      const key = document.createElement("button");
      key.type = "button";
      key.className = "key";
      key.textContent = letter;
      const normalized = normalizeLetter(letter, round.ignoreAccents);
      if (round.guessed.includes(normalized)) {
        const isCorrect = round.masked.some((revealed) => revealed && normalizeLetter(revealed, round.ignoreAccents) === normalized);
        key.classList.add(isCorrect ? "correct" : "incorrect");
        key.disabled = true;
      }
      key.addEventListener("click", () => guess(letter));
      return key;
    }));
  }

  function normalizeLetter(letter, ignoreAccents) {
    const upper = letter.toLocaleUpperCase("pt-BR");
    return ignoreAccents ? upper.normalize("NFD").replace(/\p{Diacritic}/gu, "") : upper;
  }

  function guess(letter) {
    const round = currentRound();
    if (!round || round.status !== "playing") return;
    const normalized = normalizeLetter(letter, round.ignoreAccents);
    if (round.guessed.includes(normalized)) return;
    lastGuess = normalized;
    send("guess", { letter });
  }

  function renderScoreboard(state) {
    const players = [...state.players].sort((a, b) => b.points - a.points || b.wordsFound - a.wordsFound || a.errors - b.errors);
    const activePlayerId = state.format === "turns" ? state.turnPlayerId : null;
    $("#online-count").innerHTML = `<i></i> ${state.players.filter((player) => player.connected).length} online`;
    els.scoreList.replaceChildren(...players.map((player, index) => {
      const row = document.createElement("div");
      row.className = `score-player${player.id === currentPlayerId ? " current" : ""}${player.id === activePlayerId ? " current-turn" : ""}`;
      const avatar = document.createElement("span");
      avatar.className = "player-avatar";
      avatar.style.background = initialsColor(index);
      avatar.textContent = [...player.name][0].toLocaleUpperCase("pt-BR");
      const details = document.createElement("span");
      details.className = "score-name";
      const name = document.createElement("b");
      name.textContent = player.name;
      const subtitle = document.createElement("small");
      subtitle.textContent = player.id === activePlayerId
        ? player.id === currentPlayerId ? "Sua vez" : "Vez de jogar"
        : player.host ? "Anfitrião" : `${player.wordsFound} ${player.wordsFound === 1 ? "palavra" : "palavras"}`;
      details.append(name, subtitle);
      const points = document.createElement("span");
      points.className = "score-points";
      points.textContent = `${player.points} pts`;
      row.append(avatar, details, points);
      return row;
    }));
  }

  function renderSoloScore() {
    $("#online-count").innerHTML = "<i></i> Você";
    els.scoreList.replaceChildren();
    const row = document.createElement("div");
    row.className = "score-player current";
    const avatar = document.createElement("span");
    avatar.className = "player-avatar";
    avatar.textContent = [...(soloPlayerName || "J")][0].toLocaleUpperCase("pt-BR");
    const details = document.createElement("span");
    details.className = "score-name";
    const name = document.createElement("b");
    name.textContent = soloPlayerName || "Jogador";
    const subtitle = document.createElement("small");
    subtitle.textContent = "MODO SOLO";
    details.append(name, subtitle);
    const points = document.createElement("span");
    points.className = "score-points";
    points.textContent = `${soloTotalPoints} pts`;
    row.append(avatar, details, points);
    els.scoreList.append(row);
  }

  function updateTimer(round) {
    clearInterval(clockTimer);
    if (!round.timeLimit) {
      els.timer.hidden = true;
      return;
    }
    els.timer.hidden = false;
    const update = () => {
      const paused = currentMode === "room" && roomState?.status === "paused";
      const remaining = paused && round.remainingMs !== undefined
        ? Math.ceil(round.remainingMs / 1000)
        : Math.max(0, round.timeLimit - Math.floor((Date.now() - round.startedAt) / 1000));
      els.timer.textContent = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
      els.timer.classList.toggle("urgent", remaining <= 10);
    };
    update();
    if (round.status === "playing") clockTimer = setInterval(update, 1000);
  }

  function renderSolo() {
    if (!soloState) return;
    els.roomCodeBox.hidden = true;
    els.lobby.hidden = true;
    els.finished.hidden = true;
    els.playArea.hidden = false;
    els.gameTitle.textContent = "Hora de adivinhar";
    els.gameMode.textContent = "MODO SOLO";
    $("#end-game-button").hidden = true;
    renderRound(soloState, null);
  }

  function renderRanking(players, stats) {
    const list = els.rankingList;
    list.replaceChildren();
    $("#stat-games").textContent = String(stats?.games ?? players.reduce((sum, player) => sum + player.games, 0));
    $("#stat-words").textContent = String(stats?.wordsFound ?? players.reduce((sum, player) => sum + player.wordsFound, 0));
    $("#stat-time").textContent = stats?.wordsFound ? `${Math.round(stats.totalTime / stats.wordsFound)}s` : "—";
    if (!players.length) {
      const empty = document.createElement("p");
      empty.className = "ranking-empty";
      empty.textContent = "Ainda não há partidas registradas. Seja o primeiro a jogar!";
      list.append(empty);
      return;
    }
    players.forEach((player, index) => {
      const row = document.createElement("div");
      row.className = "ranking-row";
      const rank = document.createElement("span");
      rank.className = "rank-number";
      rank.textContent = `#${index + 1}`;
      const name = document.createElement("span");
      const label = document.createElement("b");
      label.textContent = player.name;
      const stats = document.createElement("small");
      const accuracy = player.games ? Math.round((player.wins / player.games) * 100) : 0;
      stats.textContent = `${player.wordsFound} palavras · ${accuracy}% acertos · ${player.averageTime === null ? "—" : `${player.averageTime}s`} média · sequência ${player.bestStreak}`;
      name.append(label, stats);
      const points = document.createElement("span");
      points.className = "ranking-score";
      points.textContent = `${player.points} pts`;
      row.append(rank, name, points);
      list.append(row);
    });
  }

  function renderPublicRooms(rooms) {
    const container = $("#ranking-list");
    if (!els.rankingDialog.open || dialogAction !== "public") return;
    container.replaceChildren();
    if (!rooms.length) {
      const empty = document.createElement("p");
      empty.className = "ranking-empty";
      empty.textContent = "Nenhuma sala pública aberta agora. Crie uma e convide a turma!";
      container.append(empty);
      return;
    }
    rooms.forEach((room) => {
      const button = document.createElement("button");
      button.className = "ranking-row public-room-row";
      button.type = "button";
      const status = document.createElement("span");
      status.className = "rank-number";
      status.textContent = "↗";
      const details = document.createElement("span");
      const title = document.createElement("b");
      title.textContent = `Sala ${room.code}`;
      const info = document.createElement("small");
      info.textContent = `${room.players}/${room.maxPlayers} jogadores · ${room.category} · ${room.format === "turns" ? "por turnos" : "em equipe"}`;
      details.append(title, info);
      const enter = document.createElement("span");
      enter.className = "ranking-score";
      enter.textContent = "Entrar";
      button.append(status, details, enter);
      button.addEventListener("click", () => {
        els.rankingDialog.close();
        openSetup("join");
        els.roomCode.value = room.code;
      });
      container.append(button);
    });
  }

  $("#solo-button").addEventListener("click", () => openSetup("solo"));
  $("#multiplayer-button").addEventListener("click", () => {
    els.multiplayerPanel.hidden = !els.multiplayerPanel.hidden;
    if (!els.multiplayerPanel.hidden) els.multiplayerPanel.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("#close-multiplayer").addEventListener("click", () => { els.multiplayerPanel.hidden = true; });
  $("#create-room-button").addEventListener("click", () => openSetup("create"));
  $("#join-room-button").addEventListener("click", () => openSetup("join"));
  $("#public-rooms-button").addEventListener("click", () => {
    dialogAction = "public";
    $("#ranking-list").replaceChildren();
    els.rankingDialog.querySelector(".eyebrow").textContent = "PARTIDAS ABERTAS";
    els.rankingDialog.querySelector("h2").textContent = "Salas públicas";
    els.rankingDialog.querySelector("p").textContent = "Escolha uma sala e entre para jogar.";
    els.rankingDialog.showModal();
    send("public-rooms");
  });
  $("#ranking-button").addEventListener("click", () => {
    dialogAction = "ranking";
    els.rankingDialog.querySelector(".eyebrow").textContent = "A COMUNIDADE";
    els.rankingDialog.querySelector("h2").textContent = "Ranking geral";
    els.rankingDialog.querySelector("p").textContent = "Os melhores jogadores da Forca & Companhia.";
    els.rankingDialog.showModal();
    send("ranking");
  });
  $("#profile-button").addEventListener("click", () => {
    if (currentMode) return showToast("Seu apelido é definido ao iniciar uma partida.");
    openSetup("solo");
  });
  els.homeName.addEventListener("input", () => {
    const name = els.homeName.value.trim().replace(/\s+/g, " ").slice(0, 20);
    if (name) updateProfile(name);
  });
  document.querySelectorAll(".modal-close").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });
  $("#theme-toggle").addEventListener("click", () => {
    document.body.classList.toggle("light-theme");
    localStorage.setItem("forca-theme", document.body.classList.contains("light-theme") ? "light" : "dark");
  });
  $("#sound-toggle").addEventListener("click", (event) => {
    soundEnabled = !soundEnabled;
    event.currentTarget.classList.toggle("active", soundEnabled);
    showToast(soundEnabled ? "Sons ativados." : "Sons desativados.");
  });
  $("#back-home").addEventListener("click", () => {
    showHome();
  });
  $("#return-home-button").addEventListener("click", showHome);
  $("#copy-code").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(roomState.code);
      showToast("Código copiado!");
    } catch {
      showToast(`Código da sala: ${roomState.code}`);
    }
  });
  els.startGame.addEventListener("click", () => send("start-game"));
  els.next.addEventListener("click", () => send("next-round"));
  els.pause.addEventListener("click", () => send(roomState?.status === "paused" ? "resume-game" : "pause-game"));
  els.hint.addEventListener("click", () => send("hint"));
  els.playAgain.addEventListener("click", () => {
    const name = soloPlayerName;
    send("solo-start", { name, category: $("#solo-category").value, difficulty: $("#solo-difficulty").value });
  });
  els.endGame.addEventListener("click", () => {
    if (confirm("Encerrar a partida para todos os jogadores?")) send("end-game");
  });

  $("#setup-dialog").addEventListener("close", () => {
    if (els.setupDialog.returnValue !== "submit") return;
    const name = els.name.value.trim().replace(/\s+/g, " ");
    if (!name) return showToast("Digite um apelido para continuar.", true);
    if (name.length > 20) return showToast("O apelido pode ter até 20 caracteres.", true);
    localStorage.setItem("forca-name", name);
    els.homeName.value = name;
    updateProfile(name);
    if (dialogAction === "solo") {
      soloPlayerName = name;
      send("solo-start", { name, category: $("#solo-category").value, difficulty: $("#solo-difficulty").value });
    } else if (dialogAction === "create") {
      send("create-room", { name, settings: buildRoomSettings() });
    } else if (dialogAction === "join") {
      const code = els.roomCode.value.trim().toUpperCase();
      send("join-room", { name, code });
    }
  });

  ["category", "difficulty", "format", "players", "rounds", "time", "points", "perfect", "speed-points", "speed-threshold", "penalty", "public", "hints", "speed", "accents"].forEach((key) => {
    $(`#setting-${key}`).addEventListener("change", () => send("update-settings", { settings: readLobbySettings() }));
  });

  els.roomCode.addEventListener("input", () => {
    els.roomCode.value = els.roomCode.value.toUpperCase().replace(/[^A-F0-9]/g, "").slice(0, 6);
  });
  document.addEventListener("keydown", (event) => {
    if (els.setupDialog.open || els.rankingDialog.open || event.ctrlKey || event.altKey || event.metaKey) return;
    const letter = event.key.toLocaleUpperCase("pt-BR");
    if (/^[A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ]$/.test(letter) && !els.gameScreen.hidden) guess(letter);
  });

  populateCategorySelect($("#solo-category"));
  populateCategorySelect($("#create-category"));
  populateCategorySelect($("#setting-category"));
  $("#setting-category").value = "";
  els.homeName.value = localStorage.getItem("forca-name") || "";
  if (localStorage.getItem("forca-theme") === "light") document.body.classList.add("light-theme");
  updateProfile(localStorage.getItem("forca-name") || "Jogador");
  connect();
})();
