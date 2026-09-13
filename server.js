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
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();

const PORT = process.env.PORT || 3000;
const SESSION_DIR = path.resolve(
  process.env.SESSION_DIR || "./sessions"
);

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

const sessions = new Map();

function createSessionId() {
  return "WA-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

function normalizePhoneNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

function isValidPhone(number) {
  return /^[1-9]\d{7,14}$/.test(number);
}

function getDisconnectCode(lastDisconnect) {
  return (
    lastDisconnect?.error?.output?.statusCode ??
    lastDisconnect?.error?.statusCode ??
    null
  );
}

async function startWhatsAppSession(sessionId, phoneNumber, method) {
  const sessionPath = path.join(SESSION_DIR, sessionId);

  fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } =
    await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["SHEIKH LinkWave", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  const current = sessions.get(sessionId);

  if (!current) {
    try {
      sock.end();
    } catch {}
    return;
  }

  current.sock = sock;
  current.status = "connecting";
  current.error = null;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const session = sessions.get(sessionId);

    if (!session) return;

    if (qr && method === "qr") {
      try {
        session.qrDataUrl = await QRCode.toDataURL(qr);
        session.status = "waiting_for_qr";
        session.error = null;
      } catch (error) {
        console.error("QR generation error:", error);
        session.status = "error";
        session.error = "Unable to generate QR code.";
      }
    }

    if (connection === "open") {
      session.status = "connected";
      session.connectedAt = Date.now();
      session.qrDataUrl = null;
      session.pairingCode = null;
      session.error = null;

      console.log(`[${sessionId}] WhatsApp connected successfully`);
    }

    if (connection === "close") {
      const code = getDisconnectCode(lastDisconnect);

      console.log(`[${sessionId}] Connection closed: ${code}`);

      if (code === DisconnectReason.loggedOut) {
        session.status = "logged_out";
        session.error = "WhatsApp session was logged out.";
        return;
      }

      if (code === DisconnectReason.restartRequired) {
        session.status = "reconnecting";
      } else {
        session.status = "disconnected";
      }

      setTimeout(async () => {
        if (!sessions.has(sessionId)) return;

        try {
          await startWhatsAppSession(
            sessionId,
            phoneNumber,
            method
          );
        } catch (error) {
          console.error("Reconnect error:", error);

          const active = sessions.get(sessionId);
          if (active) {
            active.status = "error";
            active.error = "Unable to reconnect WhatsApp session.";
          }
        }
      }, 4000);
    }
  });

  // Pairing code is requested after the socket has had time to initialize.
  if (!state.creds.registered && method === "pairing") {
    setTimeout(async () => {
      const session = sessions.get(sessionId);

      if (!session || session.status === "connected") return;

      try {
        session.status = "generating_pairing";
        session.error = null;

        const code = await sock.requestPairingCode(phoneNumber);

        const active = sessions.get(sessionId);

        if (active) {
          active.pairingCode = code;
          active.status = "waiting_for_pairing";

          console.log(`[${sessionId}] Pairing code generated`);
        }
      } catch (error) {
        console.error(`[${sessionId}] Pairing code error:`, error);

        const active = sessions.get(sessionId);

        if (active) {
          active.status = "error";
          active.error =
            "Unable to generate pairing code. Please try again or use QR Code.";
        }
      }
    }, 3000);
  }
}

app.post("/api/session/create", async (req, res) => {
  try {
    const { phoneNumber, method } = req.body;
    const number = normalizePhoneNumber(phoneNumber);

    if (!isValidPhone(number)) {
      return res.status(400).json({
        success: false,
        message:
          "Enter a valid WhatsApp number with country code."
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
      qrDataUrl: null,
      pairingCode: null,
      error: null,
      sock: null,
      createdAt: Date.now(),
      connectedAt: null
    });

    await startWhatsAppSession(
      sessionId,
      number,
      method
    );

    return res.json({
      success: true,
      sessionId,
      status: "starting",
      pairingCode: null,
      message:
        method === "qr"
          ? "QR session started."
          : "Pairing code is being generated."
    });
  } catch (error) {
    console.error("Create session error:", error);

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
    error: session.error,
    connectedAt: session.connectedAt
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

  sessions.delete(sessionId);

  try {
    if (session.sock) {
      await session.sock.logout();
    }
  } catch (error) {
    console.error("Logout error:", error);
  }

  const sessionPath = path.join(SESSION_DIR, sessionId);

  try {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, {
        recursive: true,
        force: true
      });
    }
  } catch (error) {
    console.error("Session folder delete error:", error);
  }

  res.json({
    success: true,
    message: "Session deleted successfully."
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(
    `SHEIKH LinkWave running on port ${PORT}`
  );
});
