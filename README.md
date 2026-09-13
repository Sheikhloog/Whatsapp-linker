# LinkWave WhatsApp Pairing Platform

## Requirements
- Node.js 18 or newer
- A WhatsApp account for testing

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000

## Notes
- This project uses Baileys for WhatsApp Web connectivity.
- Use only with accounts and users who have permission.
- For public production deployment, add authentication, rate limiting, persistent session storage, HTTPS, and proper session ownership.
- WhatsApp/Baileys behavior and compatibility can change; test the installed version before production use.
