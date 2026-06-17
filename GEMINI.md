# Creating a Gemini API key for image generation

Slide Write's image generation ("nano banana") calls Google's Generative Language
API with the `gemini-2.5-flash-image` model. The `GEMINI_KEY` is just a standard
Google Gemini API key — there's nothing special to create on the Slide Write side.

## 1. Create the key at Google AI Studio

1. Go to **https://aistudio.google.com/apikey** (sign in with a Google account).
2. Click **Create API key** → pick or create a Google Cloud project.
3. Copy the key (starts with `AIza…`). It grants access to the Generative Language
   API, which is what the shim calls for image generation.

> Image models are billed/quota'd — make sure the project the key belongs to has
> access to the image model and billing enabled if you hit quota errors.

## 2. Give the key to Slide Write

Key resolution order is `body.geminiKey` → `--gemini-key` / `GEMINI_API_KEY`. Pick one:

**A — Extension (one global key, shared across origins):**
Paste the key into the Gemini key field in the extension. It's sent as `geminiKey`
in the `POST /generate-image` body. Nothing to set on the server.

**B — Server-side flag:**
```
node shim/slide-write.mjs --repo <path> --port 4040 \
  --origin http://localhost:5173 --token <secret> \
  --gemini-key AIza...
```

**C — Environment variable:**
```
export GEMINI_API_KEY=AIza...
node shim/slide-write.mjs --repo <path> --port 4040 --origin http://localhost:5173 --token <secret>
```

When the shim has a server-side key (B or C), `/meta` advertises `geminiEnv: true`
so the extension knows it doesn't need to supply one.

## Notes

- The key travels in an `x-goog-api-key` header (never the URL), so it won't leak
  into logs.
- **Never commit the key.**
- The model id is configurable via `--gemini-model` / `SLIDEWRITE_GEMINI_MODEL`
  (default `gemini-2.5-flash-image`).
