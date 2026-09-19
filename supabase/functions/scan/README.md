# Photo scanning

The app sends a photo here; this function asks **Google Gemini** to read the phrases
out of it and returns them with their meanings. The Gemini key lives on the server —
it is never in `bilig.html`, which is a public file.

Without this function the app still scans, using on-device reading (free, weaker on
Arabic, no meanings). This function adds accurate reading and automatic meanings.

## Setup

1. **Get a Gemini key** — sign in at https://aistudio.google.com, choose *Get API key*,
   and create one. No card needed for the free tier.
2. **Install the Supabase CLI** (run from your home folder):
   ```bash
   cd ~ && brew install supabase/tap/supabase
   ```
3. **From the project folder**, sign in, link, store the key, and deploy:
   ```bash
   supabase login
   supabase link --project-ref lcuratltvfmzyvcziniz
   supabase secrets set GEMINI_API_KEY=your-key-here
   supabase db push
   supabase functions deploy scan
   ```
   `db push` creates the daily scan-limit table. Don't skip it — without the table the
   function refuses every scan with "Scanning is briefly unavailable".

## Settings

| Secret | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | — | Required |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Change when Google retires a model |
| `SCAN_DAILY_LIMIT` | `20` | Scans per person per day |
| `ALLOWED_ORIGIN` | `*` | e.g. `https://you.github.io` to accept calls only from your site |
| `PUBLISHABLE_KEY` | unset | Rejects callers without your publishable key |

Set any of them with `supabase secrets set NAME=value`.

## Free tier: two things to know

- **Your photos may be used by Google.** On the free tier, Google may use what you send
  — including scanned photos — to improve its products. The paid tier does not.
- **The allowance is shared.** One key serves everyone using your app. Once Google's
  free daily limit is used up, scans fail with "Today's free scanning allowance has run
  out" until it resets. The per-person `SCAN_DAILY_LIMIT` stops one heavy user from
  using it all.

Google changes free-tier limits and model names; check AI Studio for current ones.

## Who can call it

`config.toml` sets `verify_jwt = false` so guests can scan. The endpoint is reachable by
anyone with the URL; the daily limit is what bounds use. To restrict scanning to
signed-in users, set `verify_jwt = true` and redeploy.

## Request / response

```jsonc
// POST body
{ "image": "<base64, no data: prefix>", "mediaType": "image/jpeg" }

// 200
{ "phrases": [
    { "foreign_text": "صباح الخير", "native_text": "Good morning",
      "language": "Arabic", "topic": "Greetings", "translated": false } ],
  "raw_lines": ["Lesson 1", "صباح الخير", "Good morning"] }

// error
{ "error": "Could not read that image. Try a clearer photo." }
```

`translated` is `false` when the meaning was read off the page and `true` when Gemini
wrote it — the review screen marks the latter with ✨.
