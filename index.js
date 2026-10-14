const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || 'TokenSeguro123';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://link.re9.rio.br/smart/webhook_whatsapp.php';

let sock = null;
let qrBase64 = '';
let connectionStatus = 'DISCONNECTED';

async function enviarParaMySQL(payload) {
    try {
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            body: JSON.stringify(payload)
        });
        const texto = await response.text();
        console.log(`📡 Sincronizado com MySQL:`, texto.substring(0, 120));
    } catch (e) {
        console.error('❌ Erro ao enviar para o MySQL:', e.message);
    }
}

async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: true,            // Ativa o recebimento do histórico do aparelho
        defaultQueryTimeoutMs: undefined, // Evita queda por Time Out
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        browser: Browsers.macOS('Desktop') // Simula Desktop para receber mais histórico
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
            console.log('✅ Aparelho conectado e pronto!');
        }
    });

    // 1. CAPTURA O HISTÓRICO ANTIGO E CONTATOS AO CONECTAR
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
        console.log(`📦 Recebendo pacote de histórico: ${messages.length} mensagens e ${contacts.length} contatos.`);
        
        const loteMensagens = [];
        for (const msg of messages.slice(-100)) { // Pega as últimas 100 mensagens do histórico
            if (msg.message) {
                const text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || '';
                const jid = msg.key.remoteJid || '';
                if (text && jid && !jid.includes('@g.us') && !jid.includes('status@broadcast')) {
                    loteMensagens.push({
                        from: jid.replace('@s.whatsapp.net', ''),
                        content: text,
                        direcao: msg.key.fromMe ? 'enviada' : 'recebida'
                    });
                }
            }
        }

        const loteContatos = [];
        for (const c of contacts) {
            if (c.id && c.id.includes('@s.whatsapp.net')) {
                const numero = c.id.replace('@s.whatsapp.net', '');
                const nome = c.name || c.notify || numero;
                loteContatos.push({ nome, telefone: numero });
            }
        }

        if (loteMensagens.length > 0 || loteContatos.length > 0) {
            await enviarParaMySQL({
                acao: 'sincronizar_lote',
                mensagens: loteMensagens,
                contatos: loteContatos
            });
        }
    });

    // 2. CAPTURA MENSAGENS EM TEMPO REAL (RECEBIDAS E ENVIADAS)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (msg.message) {
                const text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || '';
                const jid = msg.key.remoteJid || '';
                if (jid.includes('status@broadcast')) continue;

                const from = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
                const direction = msg.key.fromMe ? 'enviada' : 'recebida';

                if (text && from) {
                    await enviarParaMySQL({
                        acao: 'nova_mensagem',
                        from: from,
                        content: text,
                        direcao: direction
                    });
                }
            }
        }
    });
}

// Iniciar ou checar sessão
app.post('/session/start', (req, res) => {
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) return res.status(401).json({ error: 'Chave inválida' });

    if (!sock && connectionStatus !== 'CONNECTED') {
        startSock();
    }
    return res.json({ status: connectionStatus, qrcode: qrBase64 });
});

// NOVA ROTA: Enviar mensagem pelo navegador sem precisar do celular físico
app.post('/message/send', async (req, res) => {
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) return res.status(401).json({ error: 'Chave inválida' });

    const { telefone, mensagem } = req.body;
    if (!sock || connectionStatus !== 'CONNECTED') {
        return res.status(400).json({ error: 'WhatsApp não está conectado' });
    }

    try {
        const numeroLimpo = telefone.replace(/[^0-9]/g, '');
        const jid = `${numeroLimpo}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: mensagem });
        return res.json({ status: 'enviada', telefone: numeroLimpo });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Motor Smartphone Web rodando na porta ${PORT}`);
    startSock();
});
