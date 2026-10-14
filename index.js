const express = require('express');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || 'TokenSeguro123';

let sock = null;
let qrBase64 = '';
let connectionStatus = 'DISCONNECTED';

// Filas em memoria para entregar direto ao os.php (Sem bloqueio de firewall)
let filaMensagens = [];
let filaContatos = [];

function guardarContato(numero, nome) {
    const limpo = String(numero || '').replace(/[^0-9]/g, '');
    if (limpo.length >= 8 && !filaContatos.some(c => c.telefone === limpo)) {
        filaContatos.push({
            nome: nome || limpo,
            telefone: limpo
        });
        if (filaContatos.length > 500) filaContatos.shift();
    }
}

function guardarMensagem(jid, texto, fromMe, nomeContato) {
    if (!jid || !texto || jid.includes('status@broadcast')) return;
    const numero = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
    const limpo = numero.replace(/[^0-9]/g, '');
    if (!limpo) return;

    if (nomeContato) guardarContato(limpo, nomeContato);

    filaMensagens.push({
        id_unico: Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        from: limpo,
        content: String(texto).trim(),
        direcao: fromMe ? 'enviada' : 'recebida'
    });
    if (filaMensagens.length > 300) filaMensagens.shift();
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

    // 1. Captura pacote de historico e contatos ao parear
    sock.ev.on('messaging-history.set', ({ contacts, messages }) => {
        if (Array.isArray(contacts)) {
            for (const c of contacts) {
                if (c.id && c.id.includes('@s.whatsapp.net')) {
                    guardarContato(c.id.replace('@s.whatsapp.net', ''), c.name || c.notify);
                }
            }
        }
        if (Array.isArray(messages)) {
            for (const msg of messages.slice(-150)) {
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

    // 2. Captura contatos atualizados
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c.id && c.id.includes('@s.whatsapp.net')) {
                guardarContato(c.id.replace('@s.whatsapp.net', ''), c.name || c.notify);
            }
        }
    });

    // 3. Captura todas as mensagens recebidas e enviadas em tempo real
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

// Rota principal: entrega status, QR Code e despeja a fila de mensagens/contatos direto no os.php
app.post('/session/start', (req, res) => {
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) return res.status(401).json({ error: 'Chave invalida' });

    if (!sock && connectionStatus !== 'CONNECTED') {
        startSock();
    }

    const msgsParaEntregar = [...filaMensagens];
    const contatosParaEntregar = [...filaContatos];

    // Limpa a fila apos entregar ao os.php para nao duplicar
    filaMensagens = [];
    filaContatos = [];

    return res.json({
        status: connectionStatus,
        qrcode: qrBase64,
        mensagens: msgsParaEntregar,
        contatos: contatosParaEntregar
    });
});

// Rota para resetar sessao e forcar novo download de historico via QR Code
app.post('/session/reset', async (req, res) => {
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) return res.status(401).json({ error: 'Chave invalida' });
    try {
        if (sock) {
            await sock.logout();
            sock = null;
        }
    } catch (e) {}
    try {
        fs.rmSync('baileys_auth', { recursive: true, force: true });
    } catch (e) {}
    connectionStatus = 'DISCONNECTED';
    qrBase64 = '';
    startSock();
    return res.json({ status: 'RESET_OK' });
});

// Rota para enviar mensagem pelo navegador
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
    console.log(`Servidor Baileys rodando na porta ${PORT}`);
    startSock();
});

app.listen(PORT, () => {
    console.log(`Motor Smartphone Web rodando na porta ${PORT}`);
    startSock();
});
