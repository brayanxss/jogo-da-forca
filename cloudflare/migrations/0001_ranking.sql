CREATE TABLE IF NOT EXISTS match_results (
  match_id TEXT NOT NULL,
  player_key TEXT NOT NULL,
  player_name TEXT NOT NULL,
  room_code TEXT,
  points INTEGER NOT NULL CHECK (points >= 0),
  errors INTEGER NOT NULL CHECK (errors >= 0),
  time_spent_ms INTEGER NOT NULL CHECK (time_spent_ms >= 0),
  words_found INTEGER NOT NULL CHECK (words_found >= 0),
  rounds_played INTEGER NOT NULL CHECK (rounds_played >= 0),
  match_win INTEGER NOT NULL CHECK (match_win IN (0, 1)),
  best_streak INTEGER NOT NULL CHECK (best_streak >= 0),
  ended_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_key)
);

CREATE INDEX IF NOT EXISTS match_results_ended_at_idx
  ON match_results (ended_at);

CREATE INDEX IF NOT EXISTS match_results_player_ended_at_idx
  ON match_results (player_key, ended_at);

CREATE TABLE IF NOT EXISTS player_stats (
  name_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  time_spent_ms INTEGER NOT NULL DEFAULT 0,
  words_found INTEGER NOT NULL DEFAULT 0,
  rounds_played INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  last_played INTEGER NOT NULL
);
