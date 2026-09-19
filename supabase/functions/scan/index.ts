// Supabase Edge Function: POST /functions/v1/scan
//
// Takes a photo, returns the phrases in it with their meanings, using Google Gemini.
// The Gemini key lives here as a secret and never reaches the browser.
//
//   supabase secrets set GEMINI_API_KEY=...        (from aistudio.google.com)
//   supabase functions deploy scan
//
// Free-tier note: on Gemini's free tier Google may use what is sent — including
// scanned photos — to improve its products. The paid tier does not.

const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.6-flash";
const DAILY_LIMIT = Number(Deno.env.get("SCAN_DAILY_LIMIT") ?? "20");
const MAX_PHRASES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MEDIA = ["image/jpeg", "image/png", "image/webp"];
const LANGUAGES = ["Arabic", "French", "Spanish"];
const TOPICS = ["Greetings", "Politeness", "Questions", "Emotions", "Expressions", "Food", "Travel", "Other"];

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const INSTRUCTIONS = `You read photographs for a language-learning diary and pull out the phrases worth studying.

Rules:
- Return every distinct phrase in Arabic, French or Spanish, in the order they appear, up to ${MAX_PHRASES}. Prefer whole useful phrases over single words when the image groups them that way.
- MEANING: if the image already shows a translation for a phrase (a textbook column, a gloss, a caption), use that translation verbatim and set translated to false. It is the wording the learner's own material uses. Only write your own English translation when the image gives none, and then set translated to true.
- Skip page numbers, exercise numbers, headers, publisher text, and anything that is not a phrase to learn.
- Copy each phrase exactly as written, in its own script. Never invent a phrase that is not legible in the image.
- Keep Arabic diacritics (tashkeel) exactly as they appear: do not add, remove or normalize them, and do not correct spelling.
- If the image contains no Arabic, French or Spanish text, return an empty phrases list.
- Separately, in raw_lines, transcribe every line of text you can read in the image, verbatim and in reading order, including headers and anything you skipped as a phrase.`;

// Gemini's response schema (OpenAPI subset): upper-case types, no additionalProperties.
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    raw_lines: {
      type: "ARRAY",
      description: "Every line of text legible in the image, verbatim, in reading order.",
      items: { type: "STRING" },
    },
    phrases: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          foreign_text: { type: "STRING", description: "The phrase exactly as written, in its own script." },
          native_text: { type: "STRING", description: "Its English meaning." },
          language: { type: "STRING", format: "enum", enum: LANGUAGES },
          topic: { type: "STRING", format: "enum", enum: TOPICS },
          translated: { type: "BOOLEAN", description: "true if you wrote the English; false if read from the image." },
        },
        required: ["foreign_text", "native_text", "language", "topic", "translated"],
      },
    },
  },
  required: ["raw_lines", "phrases"],
};

// ── Quota ────────────────────────────────────────────────────────────────────
// Scanning is open to everyone, so each caller gets a daily allowance. This also
// stops one heavy user from using up the free-tier allowance the whole app shares.

// A signed-in user is counted by their id; everyone else by a hash of their IP
// (hashed so addresses are never stored).
async function callerId(req: Request): Promise<string> {
  const sub = userIdFromJwt(req.headers.get("Authorization"));
  if (sub) return `u:${sub}`;
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return `ip:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// Reads the subject from the JWT. The signature is NOT checked here — that is the
// gateway's job when verify_jwt is true. Use it as a quota bucket only, never as
// proof of identity.
function userIdFromJwt(header: string | null): string | null {
  const token = header?.replace(/^Bearer /, "");
  if (!token || token.split(".").length !== 3) return null;
  try {
    const body = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const sub = JSON.parse(atob(body.padEnd(Math.ceil(body.length / 4) * 4, "="))).sub;
    return typeof sub === "string" && sub ? sub : null;
  } catch {
    return null;
  }
}

// Fails CLOSED: if the counter is unreachable, refuse rather than run uncounted.
async function withinQuota(id: string): Promise<{ ok: boolean; broken?: boolean }> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { ok: false, broken: true };
  try {
    const r = await fetch(`${url}/rest/v1/rpc/bump_scan_usage`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_id: id, p_limit: DAILY_LIMIT }),
    });
    if (!r.ok) return { ok: false, broken: true };
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    return { ok: !!row?.allowed };
  } catch {
    return { ok: false, broken: true };
  }
}

// ── Gemini ───────────────────────────────────────────────────────────────────
type Phrase = { foreign_text: string; native_text: string; language: string; topic: string; translated: boolean };

// The schema constrains the model, but check what comes back anyway.
function tidy(parsed: unknown): { phrases: Phrase[]; raw_lines: string[] } {
  const obj = (parsed ?? {}) as { phrases?: unknown[]; raw_lines?: unknown[] };
  const phrases = (Array.isArray(obj.phrases) ? obj.phrases : [])
    .map((p) => p as Partial<Phrase>)
    .filter((p) => typeof p.foreign_text === "string" && p.foreign_text.trim())
    .slice(0, MAX_PHRASES)
    .map((p) => ({
      foreign_text: p.foreign_text!.trim(),
      native_text: typeof p.native_text === "string" ? p.native_text.trim() : "",
      language: LANGUAGES.includes(p.language as string) ? p.language! : "Arabic",
      topic: TOPICS.includes(p.topic as string) ? p.topic! : "Other",
      translated: p.translated === true,
    }));
  const raw_lines = (Array.isArray(obj.raw_lines) ? obj.raw_lines : [])
    .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
    .map((l) => l.trim())
    .slice(0, 60);
  return { phrases, raw_lines };
}

async function readWithGemini(apiKey: string, image: string, mediaType: string) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      // Key in a header, not the URL, so it never lands in request logs.
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: mediaType, data: image } },
            { text: "Pull out the phrases in this image, with their meanings." },
          ],
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          mediaResolution: "MEDIA_RESOLUTION_HIGH", // more tokens per image: small Arabic marks survive
        },
      }),
    },
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message: string = data?.error?.message ?? "";
    console.error("gemini error", res.status, message);
    if (res.status === 429) return { status: 429, error: "Today's free scanning allowance has run out. Try again later." };
    if (res.status === 403 || /api key/i.test(message)) return { status: 502, error: "The Gemini key on this function was rejected." };
    if (res.status === 404) return { status: 502, error: `The Gemini model "${MODEL}" isn't available. Set GEMINI_MODEL to a current one.` };
    return { status: 502, error: "Could not read that image. Try a clearer photo." };
  }

  const candidate = data?.candidates?.[0];
  if (data?.promptFeedback?.blockReason || (candidate?.finishReason && !["STOP", "MAX_TOKENS"].includes(candidate.finishReason))) {
    return { status: 200, error: "That image could not be processed.", result: { phrases: [], raw_lines: [] } };
  }

  // Skip any thought-summary parts; the answer is the JSON text.
  const text = (candidate?.content?.parts ?? [])
    .filter((p: { thought?: boolean }) => !p.thought)
    .map((p: { text?: string }) => p.text ?? "")
    .join("");
  try {
    return { status: 200, result: tidy(JSON.parse(text)) };
  } catch {
    console.error("gemini returned unparseable output", candidate?.finishReason, text.slice(0, 200));
    return { status: 502, error: "Could not read that image. Try a clearer photo." };
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ error: "GEMINI_API_KEY is not set on this function" }, 500);

  // Weak gate: blocks drive-by traffic, not a determined caller (the publishable
  // key ships in the client). The quota below is what actually bounds use.
  const expected = Deno.env.get("PUBLISHABLE_KEY");
  if (expected && req.headers.get("apikey") !== expected) return json({ error: "Not authorised" }, 401);

  let body: { image?: string; mediaType?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  const { image, mediaType } = body;
  if (!image) return json({ error: "No image supplied" }, 400);
  if (!ALLOWED_MEDIA.includes(mediaType ?? "")) return json({ error: `Unsupported image type: ${mediaType ?? "unknown"}` }, 400);
  if ((image.length * 3) / 4 > MAX_IMAGE_BYTES) return json({ error: "Image is too large — keep it under 5MB" }, 413);

  const quota = await withinQuota(await callerId(req));
  if (quota.broken) return json({ error: "Scanning is briefly unavailable. Try again shortly." }, 503);
  if (!quota.ok) return json({ error: `That's ${DAILY_LIMIT} scans today — the daily limit. It resets tomorrow.` }, 429);

  try {
    const out = await readWithGemini(apiKey, image, mediaType!);
    if (out.error && !out.result) return json({ error: out.error }, out.status);
    return json({ ...out.result, ...(out.error ? { error: out.error } : {}) }, out.status);
  } catch (err) {
    console.error("scan failed", err);
    return json({ error: "Could not read that image. Try a clearer photo." }, 502);
  }
});
