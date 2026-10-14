const express = require('express');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '100mb' }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || 'TokenSeguro123';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://link.re9.rio.br/smart/webhook_whatsapp.php';

let sock = null;
let qrBase64 = '';
let connectionStatus = 'DISCONNECTED';

let filaMensagens = [];
let filaContatos = [];

function guardarContato(numero, nome) {
    const limpo = String(numero || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (limpo.length >= 8 && !filaContatos.some(c => c.telefone === limpo)) {
        filaContatos.push({
            nome: String(nome || limpo).trim(),
            telefone: limpo
        });
        if (filaContatos.length > 2000) filaContatos.shift();
    }
}

function guardarMensagem(jid, texto, fromMe, nomeContato) {
    if (!jid || !texto || jid.includes('status@broadcast')) return;
    const limpo = String(jid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!limpo) return;

    if (nomeContato) guardarContato(limpo, nomeContato);

    const msgObj = {
        from: limpo,
        content: String(texto).trim(),
        direcao: fromMe ? 'enviada' : 'recebida'
    };

    filaMensagens.push(msgObj);
    if (filaMensagens.length > 1000) filaMensagens.shift();

    fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msgObj)
    }).catch(() => {});
}

async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
        defaultQueryTimeoutMs: undefined,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        browser: Browsers.macOS('Desktop')
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
            connectionStatus = 'DISCONNECTED';
            if (shouldReconnect) setTimeout(startSock, 3000);
        } else if (connection === 'open') {
            connectionStatus = 'CONNECTED';
            qrBase64 = '';
            console.log('WhatsApp Conectado!');
        }
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
        if (Array.isArray(contacts)) {
            for (const c of contacts) {
                if (c.id && !c.id.includes('@g.us')) {
                    guardarContato(c.id, c.name || c.notify || c.verifiedName);
                }
            }
        }
        if (Array.isArray(chats)) {
            for (const ch of chats) {
                if (ch.id && !ch.id.includes('@g.us')) {
                    guardarContato(ch.id, ch.name || ch.id);
                }
            }
        }
        if (Array.isArray(messages)) {
            for (const msg of messages) {
                if (msg.message) {
                    const text = msg.message.conversation ||
                                 msg.message.extendedTextMessage?.text ||
                                 msg.message.imageMessage?.caption || '';
                    if (text) {
                        guardarMensagem(msg.key.remoteJid, text, msg.key.fromMe, msg.pushName);
                    }
                }
            }
        }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c.id && !c.id.includes('@g.us')) {
                guardarContato(c.id, c.name || c.notify);
            }
        }
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
            if (msg.message) {
                const text = msg.message.conversation ||
                             msg.message.extendedTextMessage?.text ||
                             msg.message.imageMessage?.caption || '';
                if (text) {
                    guardarMensagem(msg.key.remoteJid, text, msg.key.fromMe, msg.pushName);
                }
            }
        }
    });
}

app.post('/session/start', (req, res) => {
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) return res.status(401).json({ error: 'Chave invalida' });

    if (!sock && connectionStatus !== 'CONNECTED') {
        startSock();
    }

    const loteMsgs = filaMensagens.splice(0, 200);
    const loteContatos = filaContatos.splice(0, 300);

    return res.json({
        status: connectionStatus,
        qrcode: qrBase64,
        mensagens: loteMsgs,
        contatos: loteContatos
    });
});

app.post('/session/reset', async (req, res) => {
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) return res.status(401).json({ error: 'Chave invalida' });
    try { if (sock) { await sock.logout(); sock = null; } } catch (e) {}
    try { fs.rmSync('baileys_auth', { recursive: true, force: true }); } catch (e) {}
    connectionStatus = 'DISCONNECTED';
    qrBase64 = '';
    startSock();
    return res.json({ status: 'RESET_OK' });
});

app.post('/message/send', async (req, res) => {
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) return res.status(401).json({ error: 'Chave invalida' });
    const { telefone, mensagem } = req.body;
    if (!sock || connectionStatus !== 'CONNECTED') {
        return res.status(400).json({ error: 'WhatsApp desconectado' });
    }
    try {
        const limpo = String(telefone).replace(/[^0-9]/g, '');
        await sock.sendMessage(`${limpo}@s.whatsapp.net`, { text: mensagem });
        return res.json({ status: 'enviada' });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Super Motor Baileys rodando na porta ${PORT}`);
    startSock();
});

app.listen(PORT, () => {
    console.log(`Super Motor Baileys rodando na porta ${PORT}`);
    startSock();
});
