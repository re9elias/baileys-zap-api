const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
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
        printQRInTerminal: false,
        syncFullHistory: false,           // Evita transferir o histórico que causava o Time Out
        defaultQueryTimeoutMs: undefined, // Desativa o tempo limite de 60s das consultas iniciais
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        browser: Browsers.appropriate('Desktop')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrBase64 = await QRCode.toDataURL(qr);
            connectionStatus = 'WAITING_QR';
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Ligação terminada (Status: ${statusCode}). A reiniciar: ${shouldReconnect}`);
            connectionStatus = 'DISCONNECTED';
            if (shouldReconnect) {
                setTimeout(startSock, 3000); // Pausa de 3 segundos antes de restabelecer o socket
            }
        } else if (connection === 'open') {
            connectionStatus = 'CONNECTED';
            qrBase64 = '';
            console.log('✅ WhatsApp conectado e pronto para receber mensagens!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (msg.message) {
                const text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || 
                             '';

                const jid = msg.key.remoteJid || '';
                const from = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
                const direction = msg.key.fromMe ? 'enviada' : 'recebida';

                if (text && from) {
                    console.log(`📩 Mensagem capturada [${direction}] de ${from}: ${text}`);
                    try {
                        const response = await fetch(WEBHOOK_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                from: from,
                                content: text,
                                direcao: direction,
                                timestamp: msg.messageTimestamp
                            })
                        });
                        const resText = await response.text();
                        console.log(`📡 Resposta do Webhook cPanel: ${resText}`);
                    } catch (e) {
                        console.error('❌ Erro no envio para o Webhook cPanel:', e.message);
                    }
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
    console.log(`Baileys Lite a correr na porta ${PORT}`);
});
