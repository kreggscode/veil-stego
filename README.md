# Veil

[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

**Hide an encrypted message in an ordinary picture — or let two AI models play hide-and-seek with a secret.**

![Veil — hide a message in plain sight](screenshot.png)

Veil is a browser-only steganography studio.

- **Hide** a message in the least-significant bits of any image. Optional passphrase encrypts it with PBKDF2 + AES-GCM.
- **Seek** a Veil PNG and read the message back. Everything is decoded locally.
- **Generate a cover** with a Pollinations image model, then hide the message in it.
- **Write a decoy caption** with a Pollinations text model, so the post around the picture has a plausible story.
- **Fable mode** recreates the LessWrong experiment: one Pollinations model draws an SVG that hides a secret, then a fresh model gets the same source and tries to find it.

## Why it is different

| | Typical LSB tool | Veil |
|---|---|---|
| Payload | plain bits in pixel order | seeded permutation across R/G/B |
| Secrecy | none | optional AES-GCM + PBKDF2 |
| Integrity | none | CRC-32 header + GCM tag |
| Covers | upload only | upload or Pollinations image model |
| Play | decode only | hide-and-seek between two models |

The least-significant bit of a pixel is visually invisible, so the image looks unchanged. Without the passphrase, the payload is ciphertext; without the header, it is noise.

## Fable mode

The LessWrong post about a model hiding a message in an SVG it drew, and a fresh model trying to find it, is the whole idea. Veil runs that round in the browser:

1. A model (`mistral`) returns `{ "svg": "...", "scheme": "..." }` with the secret encoded in the source.
2. The SVG is rendered in an `<img>` (no scripts run).
3. A fresh model (`openai`) receives only the SVG source and tries to recover the message.
4. Veil compares the guess with the secret and reveals the hider's scheme.

It is a game, not a security claim. The point is watching one model's hiding strategy meet another model's search strategy.

## Bring your own Pollen

AI features use the user's own Pollen through the [device flow](https://enter.pollinations.ai/api/device/code). Click **Connect Pollinations**, approve the short code, and a short-lived key is stored in this tab's `sessionStorage`. No server, no app key, no analytics, nothing sent anywhere except the Pollinations requests the user triggers.

The local hide/seek tools work with no connection at all.

## Format

A 64-byte header is written into the first 512 RGB channels:

```
0..3    "VEIL"
4       version (1)
5       flags (bit 0 = encrypted)
6..9    payload length (uint32 BE)
10..25  salt (PBKDF2, when encrypted)
26..37  IV (AES-GCM, when encrypted)
38..41  CRC-32 of the payload
42..63  reserved
```

The payload is scattered over the remaining RGB channels with a permutation derived from the salt (encrypted) or a fixed seed (plain). The alpha channel is never touched. Output is PNG; re-saving as JPEG destroys the payload.

## Run locally

Any static server works:

```bash
npx serve .
# or
python -m http.server 8080
```

Open `http://localhost:8080`.

## Limits

- PNG output only. JPEG re-encoding destroys the least-significant bits.
- Covers larger than 2048 px are scaled down before hiding.
- A passphrase protects the message, not the fact that an image carries one.
- Fable mode needs a Pollinations connection and two model calls.

## License

MIT — see [LICENSE](LICENSE).
