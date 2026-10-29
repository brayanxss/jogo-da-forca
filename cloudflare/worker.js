import { GameDirectory } from "./directory.js";
import { GameRoom } from "./room.js";
import { PlayerSession } from "./session.js";
import { WORDS } from "./shared.js";

export { GameDirectory, GameRoom, PlayerSession };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, words: WORDS.length, runtime: "cloudflare-workers" });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return env.SESSIONS.get(env.SESSIONS.newUniqueId()).fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};
