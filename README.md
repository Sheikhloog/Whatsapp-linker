# SHEIKH LinkWave

WhatsApp QR and pairing-code session manager.

## Local setup

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Render settings

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

Environment variables:

```env
PORT=10000
SESSION_DIR=./sessions
```

## Important

- The `sessions` folder is created automatically.
- Do not upload session authentication files to GitHub.
- Pairing code and session credentials must never be shared.
- A normal Render ephemeral filesystem may lose sessions after restart. Use persistent storage or a VPS for production.
