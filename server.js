require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");
const P = require("pino");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const SESSION_DIR = process.env.SESSION_DIR || "./sessions";

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

const sessions = new Map();

function createSessionId() {
  return "WA-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

function normalizePhoneNumber(number) {
  return String(number || "").replace(/[^\d]/g, "");
}

function isValidPhone(number) {
  return /^\d{8,15}$/.test(number);
}

async function startWhatsAppSession(sessionId, phoneNumber, method) {
  const sessionPath = path.join(SESSION_DIR, sessionId);

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch {
    version = [2, 3000, 1015901307];
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" }),
    browser: ["WhatsApp Pairing Web", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: false
  });

  const session = sessions.get(sessionId);
  if (!session) return;

  session.sock = sock;
  session.status = "connecting";

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const current = sessions.get(sessionId);
    if (!current) return;

    if (qr) {
      current.qr = qr;
      try {
        current.qrDataUrl = await QRCode.toDataURL(qr);
      } catch (error) {
        current.error = "QR generation failed.";
      }
    }

    if (connection === "open") {
      current.status = "connected";
      current.qr = null;
      current.qrDataUrl = null;
      current.pairingCode = null;
      console.log(`[${sessionId}] Connected`);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      current.status = "disconnected";
      console.log(`[${sessionId}] Disconnected: ${statusCode}`);

      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          if (sessions.has(sessionId)) {
            startWhatsAppSession(sessionId, phoneNumber, method).catch(console.error);
          }
        }, 3000);
      }
    }
  });

  if (!state.creds.registered && method === "pairing") {
    try {
      // Pairing code should be requested using the normalized international number.
      const code = await sock.requestPairingCode(phoneNumber);
      const current = sessions.get(sessionId);
      if (current) {
        current.pairingCode = code;
        current.status = "waiting_for_pairing";
      }
    } catch (error) {
      console.error("Pairing code error:", error);
      const current = sessions.get(sessionId);
      if (current) {
        current.status = "error";
        current.error = "Unable to generate pairing code. Try again.";
      }
    }
  }
}

app.post("/api/session/create", async (req, res) => {
  try {
    const { phoneNumber, method } = req.body;
    const number = normalizePhoneNumber(phoneNumber);

    if (!isValidPhone(number)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid WhatsApp number with country code."
      });
    }

    if (!["qr", "pairing"].includes(method)) {
      return res.status(400).json({
        success: false,
        message: "Invalid connection method."
      });
    }

    const sessionId = createSessionId();

    sessions.set(sessionId, {
      id: sessionId,
      phoneNumber: number,
      method,
      status: "starting",
      qr: null,
      qrDataUrl: null,
      pairingCode: null,
      error: null,
      sock: null,
      createdAt: Date.now()
    });

    await startWhatsAppSession(sessionId, number, method);
    const session = sessions.get(sessionId);

    return res.json({
      success: true,
      sessionId,
      status: session.status,
      pairingCode: method === "pairing" ? session.pairingCode : null,
      message: method === "qr"
        ? "QR session created."
        : "Pairing session created."
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Failed to create WhatsApp session."
    });
  }
});

app.get("/api/session/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      message: "Session not found."
    });
  }

  res.json({
    success: true,
    sessionId: session.id,
    status: session.status,
    qrDataUrl: session.qrDataUrl,
    pairingCode: session.pairingCode,
    error: session.error
  });
});

app.delete("/api/session/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      message: "Session not found."
    });
  }

  try {
    if (session.sock) await session.sock.logout();
  } catch (error) {
    console.error("Logout error:", error);
  }

  sessions.delete(sessionId);

  res.json({
    success: true,
    message: "Session deleted."
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`WhatsApp Pairing Platform running on port ${PORT}`);
});