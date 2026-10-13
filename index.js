const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || 'TokenSeguro123';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://link.re9.rio.br/smart/webhook_whatsapp.php';

let sock = null;
let qrBase64 = '';
let connectionStatus = 'DISCONNECTED';

async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrBase64 = await QRCode.toDataURL(qr);
            connectionStatus = 'WAITING_QR';
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            connectionStatus = 'DISCONNECTED';
            if (shouldReconnect) startSock();
        } else if (connection === 'open') {
            connectionStatus = 'CONNECTED';
            qrBase64 = '';
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.key.fromMe && msg.message) {
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                const from = msg.key.remoteJid ? msg.key.remoteJid.replace('@s.whatsapp.net', '') : '';
                try {
                    await fetch(WEBHOOK_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            event: 'messages.upsert',
                            from: from,
                            content: text,
                            timestamp: msg.messageTimestamp
                        })
                    });
                } catch (e) {
                    console.error('Falha no webhook:', e.message);
                }
            }
        }
    });
}

app.post('/session/start', (req, res) => {
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) return res.status(401).json({ error: 'Chave inválida' });

    if (!sock && connectionStatus !== 'CONNECTED') {
        startSock();
    }

    return res.json({
        status: connectionStatus,
        qrcode: qrBase64
    });
});

app.listen(PORT, () => {
    console.log(`Baileys Lite rodando na porta ${PORT}`);
});
