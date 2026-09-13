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
  jidNormalizedUser
} = require("@whiskeysockets/baileys");

const app = express();

/* =========================
   CONFIGURATION
========================= */

const PORT = process.env.PORT || 3000;

const SESSION_DIR = path.resolve(
  process.env.SESSION_DIR || "./sessions"
);

const SESSION_EXPORT_SECRET =
  process.env.SESSION_EXPORT_SECRET || "";

const MAX_SESSION_AGE =
  Number(process.env.MAX_SESSION_AGE || 86400000); // 24 hours

/* =========================
   MIDDLEWARE
========================= */

app.disable("x-powered-by");

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Export-Secret"]
  })
);

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

/* =========================
   SESSION DIRECTORY
========================= */

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, {
    recursive: true
  });
}

/*
  Runtime sessions:
  sessionId => {
    id,
    phoneNumber,
    method,
    status,
    qrDataUrl,
    pairingCode,
    error,
    sock,
    createdAt,
    connectedAt,
    whatsappJid,
    whatsappNumber
  }
*/

const sessions = new Map();

/* =========================
   HELPERS
========================= */

function createSessionId() {
  return (
    "WA-" +
    crypto
      .randomBytes(6)
      .toString("hex")
      .toUpperCase()
  );
}

function normalizePhoneNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

function isValidPhone(number) {
  return /^[1-9]\d{7,14}$/.test(number);
}

function isValidSessionId(sessionId) {
  return /^WA-[A-F0-9]{12}$/.test(sessionId);
}

function getDisconnectCode(lastDisconnect) {
  return (
    lastDisconnect?.error?.output?.statusCode ??
    lastDisconnect?.error?.statusCode ??
    null
  );
}

function getNumberFromJid(jid) {
  if (!jid) return null;

  return String(jid)
    .split(":")[0]
    .split("@")[0]
    .replace(/\D/g, "");
}

function safeSessionResponse(session) {
  return {
    success: true,
    sessionId: session.id,
    status: session.status,
    qrDataUrl: session.qrDataUrl || null,
    pairingCode: session.pairingCode || null,
    error: session.error || null,
    connectedAt: session.connectedAt || null,
    whatsappNumber: session.whatsappNumber || null
  };
}

function getSessionFolder(sessionId) {
  return path.join(SESSION_DIR, sessionId);
}

function deleteSessionFolder(sessionId) {
  const sessionPath = getSessionFolder(sessionId);

  try {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, {
        recursive: true,
        force: true
      });
    }

    return true;
  } catch (error) {
    console.error(
      `[${sessionId}] Session folder delete error:`,
      error
    );

    return false;
  }
}

function requireExportSecret(req, res, next) {
  /*
    Export secret can be sent through:
    X-Export-Secret header
    OR
    Authorization: Bearer YOUR_SECRET
  */

  if (!SESSION_EXPORT_SECRET) {
    return res.status(503).json({
      success: false,
      message:
        "Session export is disabled. Configure SESSION_EXPORT_SECRET first."
    });
  }

  const headerSecret =
    req.headers["x-export-secret"] || "";

  const authorization =
    req.headers.authorization || "";

  const bearerSecret = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  const providedSecret =
    headerSecret || bearerSecret;

  if (
    !providedSecret ||
    providedSecret !== SESSION_EXPORT_SECRET
  ) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized session export request."
    });
  }

  next();
}

/* =========================
   START WHATSAPP SESSION
========================= */

async function startWhatsAppSession(
  sessionId,
  phoneNumber,
  method
) {
  const sessionPath = getSessionFolder(sessionId);

  fs.mkdirSync(sessionPath, {
    recursive: true
  });

  const { state, saveCreds } =
    await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    auth: state,

    logger: P({
      level: "silent"
    }),

    printQRInTerminal: false,

    browser: [
      "SHEIKH LinkWave",
      "Chrome",
      "1.0.0"
    ],

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

  sock.ev.on(
    "connection.update",
    async (update) => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      const session = sessions.get(sessionId);

      if (!session) return;

      /* QR CODE */

      if (qr && method === "qr") {
        try {
          session.qrDataUrl =
            await QRCode.toDataURL(qr);

          session.status = "waiting_for_qr";
          session.error = null;
        } catch (error) {
          console.error(
            `[${sessionId}] QR generation error:`,
            error
          );

          session.status = "error";
          session.error =
            "Unable to generate QR code.";
        }
      }

      /* CONNECTION OPEN */

      if (connection === "open") {
        session.status = "connected";
        session.connectedAt = Date.now();
        session.qrDataUrl = null;
        session.pairingCode = null;
        session.error = null;

        try {
          const userJid =
            sock.user?.id ||
            sock.user?.jid ||
            null;

          session.whatsappJid = userJid;
          session.whatsappNumber =
            getNumberFromJid(userJid) ||
            phoneNumber;
        } catch (error) {
          session.whatsappNumber = phoneNumber;
        }

        console.log(
          `[${sessionId}] WhatsApp connected: ${session.whatsappNumber}`
        );
      }

      /* CONNECTION CLOSED */

      if (connection === "close") {
        const code =
          getDisconnectCode(lastDisconnect);

        console.log(
          `[${sessionId}] Connection closed: ${code}`
        );

        if (
          code === DisconnectReason.loggedOut
        ) {
          session.status = "logged_out";
          session.error =
            "WhatsApp session was logged out.";

          return;
        }

        if (
          code === DisconnectReason.restartRequired
        ) {
          session.status = "reconnecting";
        } else {
          session.status = "disconnected";
        }

        setTimeout(async () => {
          if (!sessions.has(sessionId)) {
            return;
          }

          const activeSession =
            sessions.get(sessionId);

          if (
            activeSession.status === "logged_out"
          ) {
            return;
          }

          try {
            await startWhatsAppSession(
              sessionId,
              phoneNumber,
              method
            );
          } catch (error) {
            console.error(
              `[${sessionId}] Reconnect error:`,
              error
            );

            const active =
              sessions.get(sessionId);

            if (active) {
              active.status = "error";
              active.error =
                "Unable to reconnect WhatsApp session.";
            }
          }
        }, 4000);
      }
    }
  );

  /* PAIRING CODE */

  if (
    !state.creds.registered &&
    method === "pairing"
  ) {
    setTimeout(async () => {
      const session =
        sessions.get(sessionId);

      if (!session) return;

      if (session.status === "connected") {
        return;
      }

      try {
        session.status = "generating_pairing";
        session.error = null;

        const code =
          await sock.requestPairingCode(
            phoneNumber
          );

        const active =
          sessions.get(sessionId);

        if (active) {
          active.pairingCode = code;
          active.status = "waiting_for_pairing";

          console.log(
            `[${sessionId}] Pairing code generated`
          );
        }
      } catch (error) {
        console.error(
          `[${sessionId}] Pairing code error:`,
          error
        );

        const active =
          sessions.get(sessionId);

        if (active) {
          active.status = "error";
          active.error =
            "Unable to generate pairing code. Please try again or use QR Code.";
        }
      }
    }, 3000);
  }
}

/* =========================
   CREATE SESSION
========================= */

app.post(
  "/api/session/create",
  async (req, res) => {
    try {
      const {
        phoneNumber,
        method
      } = req.body;

      const number =
        normalizePhoneNumber(phoneNumber);

      if (!isValidPhone(number)) {
        return res.status(400).json({
          success: false,
          message:
            "Enter a valid WhatsApp number with country code."
        });
      }

      if (
        !["qr", "pairing"].includes(method)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid connection method."
        });
      }

      const sessionId =
        createSessionId();

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
        connectedAt: null,
        whatsappJid: null,
        whatsappNumber: null
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
      console.error(
        "Create session error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to create WhatsApp session."
      });
    }
  }
);

/* =========================
   SESSION STATUS
========================= */

app.get(
  "/api/session/:sessionId",
  (req, res) => {
    const {
      sessionId
    } = req.params;

    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid session ID."
      });
    }

    const session =
      sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session not found."
      });
    }

    return res.json(
      safeSessionResponse(session)
    );
  }
);

/* =========================
   SECURE SESSION EXPORT
========================= */

/*
  This endpoint confirms that the session
  is connected and returns metadata.

  Do not expose Baileys auth files or private
  keys directly to the public frontend.
*/

app.get(
  "/api/session/:sessionId/export",
  requireExportSecret,
  (req, res) => {
    const {
      sessionId
    } = req.params;

    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid session ID."
      });
    }

    const session =
      sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session not found."
      });
    }

    if (session.status !== "connected") {
      return res.status(409).json({
        success: false,
        message:
          "WhatsApp session is not connected yet.",
        status: session.status
      });
    }

    return res.json({
      success: true,
      sessionId: session.id,
      status: session.status,
      whatsappNumber: session.whatsappNumber,
      whatsappJid: session.whatsappJid,
      sessionPath: getSessionFolder(sessionId),
      message:
        "Session is connected. Auth files are stored securely on the server."
    });
  }
);

/* =========================
   SESSION DELETE / LOGOUT
========================= */

app.delete(
  "/api/session/:sessionId",
  async (req, res) => {
    const {
      sessionId
    } = req.params;

    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid session ID."
      });
    }

    const session =
      sessions.get(sessionId);

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
      console.error(
        `[${sessionId}] Logout error:`,
        error
      );
    }

    deleteSessionFolder(sessionId);

    return res.json({
      success: true,
      message:
        "Session deleted successfully."
    });
  }
);

/* =========================
   HEALTH CHECK
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "SHEIKH LinkWave",
    status: "online",
    uptime: process.uptime(),
    activeSessions: sessions.size,
    timestamp: new Date().toISOString()
  });
});

/* =========================
   AUTO CLEANUP
========================= */

setInterval(() => {
  const now = Date.now();

  for (const [
    sessionId,
    session
  ] of sessions.entries()) {
    const age =
      now - session.createdAt;

    if (
      age > MAX_SESSION_AGE &&
      session.status !== "connected"
    ) {
      console.log(
        `[${sessionId}] Removing expired session`
      );

      try {
        if (session.sock) {
          session.sock.end();
        }
      } catch {}

      sessions.delete(sessionId);
      deleteSessionFolder(sessionId);
    }
  }
}, 10 * 60 * 1000);

/* =========================
   FRONTEND FALLBACK
========================= */

app.get("*", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(
    `SHEIKH LinkWave running on port ${PORT}`
  );
});
