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
const SESSION_DIR = path.resolve(
  process.env.SESSION_DIR || "./sessions"
);

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

/*
  sessions Map:
  trackingId = temporary ID used internally for polling
  publicSessionId = generated only after WhatsApp successfully connects
*/
const sessions = new Map();

function createTrackingId() {
  return "TRACK-" + crypto.randomBytes(8).toString("hex");
}

function createPublicSessionId() {
  return "WA-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

function normalizePhoneNumber(number) {
  return String(number || "").replace(/[^\d]/g, "");
}

function isValidPhone(number) {
  return /^\d{8,15}$/.test(number);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startWhatsAppSession(
  trackingId,
  phoneNumber,
  method
) {
  const session = sessions.get(trackingId);

  if (!session) {
    throw new Error("Session not found.");
  }

  const sessionPath = path.join(SESSION_DIR, trackingId);

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  const { state, saveCreds } =
    await useMultiFileAuthState(sessionPath);

  let version;

  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch (error) {
    console.log("Using fallback Baileys version.");
    version = [2, 3000, 1015901307];
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" }),
    browser: ["SheikhWave", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  session.sock = sock;
  session.status = "connecting";

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const {
      connection,
      lastDisconnect,
      qr
    } = update;

    const current = sessions.get(trackingId);

    if (!current) return;

    // QR code received
    if (qr) {
      current.qr = qr;

      try {
        current.qrDataUrl = await QRCode.toDataURL(qr);
        current.status = "waiting_for_qr";
      } catch (error) {
        console.error("QR generation error:", error);
        current.error = "QR generation failed.";
        current.status = "error";
      }
    }

    // Successfully connected
    if (connection === "open") {
      current.status = "connected";

      // Public Session ID ONLY after successful connection
      if (!current.publicSessionId) {
        current.publicSessionId = createPublicSessionId();
      }

      current.qr = null;
      current.qrDataUrl = null;
      current.pairingCode = null;
      current.error = null;

      console.log(
        `[${trackingId}] WhatsApp connected`
      );

      console.log(
        `[${trackingId}] Session ID: ${current.publicSessionId}`
      );
    }

    // Connection closed
    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      console.log(
        `[${trackingId}] Disconnected: ${statusCode}`
      );

      current.status = "disconnected";

      /*
        Do not reconnect if user logged out.
        Also do not repeatedly request pairing code.
      */
      if (
        statusCode !== DisconnectReason.loggedOut &&
        statusCode !== DisconnectReason.connectionReplaced
      ) {
        setTimeout(() => {
          const activeSession = sessions.get(trackingId);

          if (!activeSession) return;

          startWhatsAppSession(
            trackingId,
            phoneNumber,
            method
          ).catch((error) => {
            console.error(
              "Reconnect error:",
              error.message
            );
          });
        }, 5000);
      }
    }
  });

  /*
    Pairing code:
    Wait a little after socket creation.
    This fixes "Unable to generate pairing code" in many cases.
  */
  if (
    !state.creds.registered &&
    method === "pairing" &&
    !session.pairingRequested
  ) {
    session.pairingRequested = true;

    try {
      // Give Baileys time to initialize
      await wait(3000);

      const current = sessions.get(trackingId);

      if (!current) return;

      if (current.status === "connected") {
        return;
      }

      const code = await sock.requestPairingCode(
        phoneNumber
      );

      const updatedSession = sessions.get(trackingId);

      if (updatedSession) {
        updatedSession.pairingCode = code;
        updatedSession.status = "waiting_for_pairing";
        updatedSession.error = null;

        console.log(
          `[${trackingId}] Pairing code generated: ${code}`
        );
      }
    } catch (error) {
      console.error(
        `[${trackingId}] Pairing code error:`,
        error
      );

      const current = sessions.get(trackingId);

      if (current) {
        current.status = "error";
        current.error =
          "Unable to generate pairing code. Please try again with a valid number.";
      }
    }
  }
}

/*
  Create a new WhatsApp connection
*/
app.post("/api/session/create", async (req, res) => {
  try {
    const {
      phoneNumber,
      method
    } =
