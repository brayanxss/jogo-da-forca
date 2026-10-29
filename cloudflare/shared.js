import wordbank from "../wordbank.js";

export const WORDS = wordbank.WORDS;
export const CATEGORIES = wordbank.CATEGORIES;
export const MAX_ERRORS = 6;

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function cleanName(value) {
  if (typeof value !== "string") return "";
  const name = value.trim().replace(/\s+/g, " ");
  return name.length <= 20 ? name : "";
}

export function normalizeLetter(value, ignoreAccents) {
  if (typeof value !== "string" || !/^[a-záàâãéêíóôõúüç]$/i.test(value)) return null;
  const upper = value.toLocaleUpperCase("pt-BR");
  return ignoreAccents ? upper.normalize("NFD").replace(/\p{Diacritic}/gu, "") : upper;
}

export function randomItem(items) {
  if (!items.length) throw new Error("Não há palavras disponíveis para essa seleção.");
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return items[value[0] % items.length];
}

export function randomRoomCode() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0].toString(16).padStart(8, "0").slice(-6).toUpperCase();
}

export function makePlayerToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function postJson(stub, path, body) {
  return stub.fetch(`https://internal.forca${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

export async function directoryStub(env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
}

export async function roomStub(env, code) {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

export async function deliverToSession(env, sessionId, message) {
  const id = env.SESSIONS.idFromString(sessionId);
  return postJson(env.SESSIONS.get(id), "/_deliver", message);
}
