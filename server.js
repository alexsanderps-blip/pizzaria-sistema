// ============================================
// SERVIDOR PRINCIPAL - PIZZARIA + TOTEM + PAINÉIS
// ============================================

// 🔥 CARREGA VARIÁVEIS DE AMBIENTE
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// 🔥 DETECTA O AMBIENTE (LOCAL vs PRODUÇÃO)
// ============================================
const IS_PRODUCTION = 
    process.env.NODE_ENV === 'production' || 
    process.env.RENDER === 'true' ||
    !!process.env.RENDER_EXTERNAL_URL;

console.log(`🌍 Ambiente: ${IS_PRODUCTION ? 'PRODUÇÃO (Render)' : 'LOCAL (Dev)'}`);

// ============================================
// MIDDLEWARES
// ============================================
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// DESCOBRE O IP DA REDE LOCAL (para totem no iPhone)
// ============================================
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const LOCAL_IP = getLocalIP();

// 🔥 URL BASE DINÂMICA
const URL_BASE = process.env.RENDER_EXTERNAL_URL || `http://${LOCAL_IP}:${PORT}`;

// ============================================
// BANCO DE DADOS SQLITE
// ============================================
let db;

let whatsappTentandoReconectar = false;
async function initDatabase() {
    // 🔥 ESCOLHE O CAMINHO BASEADO NO AMBIENTE
    const dbDir = IS_PRODUCTION
        ? '/opt/render/project/src/database'
        : path.join(__dirname, 'database');

    // Cria a pasta se não existir
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        console.log('📁 Pasta database/ criada em:', dbDir);
    }

    const dbPath = path.join(dbDir, 'pizzaria.db');
    console.log('💾 Banco de dados:', dbPath);

    db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    // ==========================================
    // TABELA: CLIENTES
    // ==========================================
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clientes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telefone TEXT UNIQUE NOT NULL,
            nome TEXT,
            endereco TEXT,
            numero TEXT,
            bairro TEXT,
            cidade TEXT,
            complemento TEXT,
            cep TEXT,
            data_cadastro DATETIME DEFAULT CURRENT_TIMESTAMP,
            ultimo_pedido DATETIME
        )
    `);

    // ==========================================
    // TABELA: PEDIDOS
    // ==========================================
    await db.exec(`
        CREATE TABLE IF NOT EXISTS pedidos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            numero_pedido INTEGER UNIQUE NOT NULL,
            cliente_id INTEGER,
            itens TEXT,
            total REAL,
            forma_pagamento TEXT,
            status TEXT DEFAULT 'recebido',
            endereco_entrega TEXT,
            observacao TEXT,
            data_pedido DATETIME DEFAULT CURRENT_TIMESTAMP,
            data_entrega DATETIME,
            motoboy_id INTEGER,
            FOREIGN KEY (cliente_id) REFERENCES clientes(id)
        )
    `);

    // ==========================================
    // TABELA: MOTOBOYS
    // ==========================================
    await db.exec(`
        CREATE TABLE IF NOT EXISTS motoboys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            telefone TEXT UNIQUE NOT NULL,
            veiculo TEXT,
            placa TEXT,
            status TEXT DEFAULT 'disponivel',
            data_cadastro DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ==========================================
    // TABELA: TOKENS WHATSAPP
    // ==========================================
    await db.exec(`
        CREATE TABLE IF NOT EXISTS tokens_whatsapp (
            telefone TEXT PRIMARY KEY,
            token TEXT UNIQUE NOT NULL,
            data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
            data_uso DATETIME
        )
    `);

    // ==========================================
    // TABELA: HISTÓRICO DE STATUS
    // ==========================================
    await db.exec(`
        CREATE TABLE IF NOT EXISTS historico_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pedido_id INTEGER,
            status TEXT,
            data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
            observacao TEXT
        )
    `);

    console.log('✅ Banco de dados SQLite inicializado!');
}

// ============================================
// WHATSAPP CLIENT (só roda em LOCAL)
// ============================================
let whatsappClient = null;
let whatsappReady = false;

async function initWhatsApp() {
    try {
        console.log('🔄 Iniciando WhatsApp...');
        
        whatsappClient = new Client({
            authStrategy: new LocalAuth({ clientId: 'pizzaria' }),
            restartOnAuthFail: true,
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-extensions'
                ]
            }
        });

        whatsappClient.on('qr', qr => {
            console.log('📱 Escaneie o QR Code para conectar o WhatsApp:');
            qrcode.generate(qr, { small: true });
        });

        whatsappClient.on('ready', () => {
            whatsappReady = true;
            whatsappTentandoReconectar = false;
            console.log('✅ WhatsApp conectado!');
        });

        whatsappClient.on('authenticated', () => {
            console.log('🔐 WhatsApp autenticado!');
        });

        whatsappClient.on('auth_failure', (msg) => {
            console.error('❌ Falha na autenticação:', msg);
            whatsappReady = false;
        });

        whatsappClient.on('disconnected', (reason) => {
            console.warn('⚠️ WhatsApp desconectado:', reason);
            whatsappReady = false;
            // Tenta reconectar
            if (!whatsappTentandoReconectar) {
                whatsappTentandoReconectar = true;
                setTimeout(() => {
                    console.log('🔄 Tentando reconectar WhatsApp...');
                    initWhatsApp();
                }, 10000);
            }
        });

        whatsappClient.on('message', async message => {
            await processarMensagemWhatsApp(message);
        });

        // 🔥 TRATA O ERRO "Execution context was destroyed"
        whatsappClient.on('loading_screen', (percent, message) => {
            console.log(`⏳ Carregando WhatsApp: ${percent}% - ${message}`);
        });

        await whatsappClient.initialize();
        
    } catch (error) {
        console.error('❌ Erro ao iniciar WhatsApp:', error.message);
        whatsappReady = false;
        
        // 🔥 SE FOR O ERRO "Execution context was destroyed", tenta de novo
        if (error.message && error.message.includes('Execution context was destroyed')) {
            console.log('🔄 Contexto destruído. Tentando reiniciar em 10 segundos...');
            
            // Destrói o cliente atual
            if (whatsappClient) {
                try {
                    await whatsappClient.destroy();
                } catch (e) {}
                whatsappClient = null;
            }
            
            // Tenta novamente
            if (!whatsappTentandoReconectar) {
                whatsappTentandoReconectar = true;
                setTimeout(() => {
                    whatsappTentandoReconectar = false;
                    initWhatsApp();
                }, 10000);
            }
        }
    }
}

// 🔥 TRATA PROMISES NÃO TRATADAS (o erro pode vir por fora)
process.on('unhandledRejection', (err) => {
    if (String(err).includes('Execution context was destroyed')) {
        console.warn('⚠️ Contexto do WhatsApp foi destruído. Reiniciando...');
        whatsappReady = false;
        if (whatsappClient) {
            try {
                whatsappClient.destroy().finally(() => {
                    setTimeout(() => initWhatsApp(), 5000);
                });
            } catch (e) {
                setTimeout(() => initWhatsApp(), 5000);
            }
        }
    }
});

// ============================================
// PROCESSAR MENSAGENS DO WHATSAPP
// ============================================
async function processarMensagemWhatsApp(message) {
    if (message.from.includes('g.us')) return;

    const telefone = message.from.replace('@c.us', '');
    const texto = message.body.toLowerCase().trim();

    console.log(`📩 Mensagem de ${telefone}: ${texto}`);

    if (texto === 'link' || texto === 'comprar' || texto === 'pedido') {
        await gerarLinkCompra(telefone, message);
        return;
    }

    if (texto === 'status' || texto === 'meu pedido') {
        await verificarStatusPedido(telefone, message);
        return;
    }

    if (texto === 'ajuda' || texto === 'help' || texto === 'oi' || texto === 'olá' || texto === 'ola') {
        await message.reply(
            `🍕 *Pizzaria do Zé*\n\n` +
            `Olá! 👋 Como posso ajudar?\n\n` +
            `📌 Digite *link* para fazer seu pedido\n` +
            `📌 Digite *status* para acompanhar\n` +
            `📌 Digite *ajuda* para ver os comandos`
        );
        return;
    }

    await message.reply(
        `🍕 *Pizzaria do Zé*\n\n` +
        `📌 Digite *link* para fazer seu pedido\n` +
        `📌 Digite *status* para acompanhar`
    );
}

// ============================================
// GERAR LINK DE COMPRA
// ============================================
async function gerarLinkCompra(telefone, message) {
    try {
        let cliente = await db.get('SELECT * FROM clientes WHERE telefone = ?', [telefone]);

        if (!cliente) {
            await db.run('INSERT INTO clientes (telefone, nome) VALUES (?, ?)',
                [telefone, `Cliente ${telefone.slice(-4)}`]);
            cliente = await db.get('SELECT * FROM clientes WHERE telefone = ?', [telefone]);
        }

        const token = Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15);

        await db.run(
            'INSERT OR REPLACE INTO tokens_whatsapp (telefone, token) VALUES (?, ?)',
            [telefone, token]
        );

        const linkPedido = `${URL_BASE}/pedido?tel=${telefone}&token=${token}`;

        let mensagemEndereco = '';
        if (cliente.endereco) {
            mensagemEndereco = `\n\n📍 *Endereço cadastrado:*\n${cliente.endereco}, ${cliente.numero}\n${cliente.bairro} - ${cliente.cidade}`;
        }

        await message.reply(
            `🍕 *Link para fazer seu pedido!*\n\n` +
            `🔗 ${linkPedido}\n\n` +
            `💡 *Dica:* Salve este link!${mensagemEndereco}`
        );

        console.log(`✅ Link gerado para ${telefone}: ${linkPedido}`);

    } catch (error) {
        console.error('❌ Erro ao gerar link:', error);
        await message.reply('❌ Erro ao gerar link. Tente novamente.');
    }
}

// ============================================
// VERIFICAR STATUS DO PEDIDO
// ============================================
async function verificarStatusPedido(telefone, message) {
    try {
        const cliente = await db.get('SELECT id FROM clientes WHERE telefone = ?', [telefone]);

        if (!cliente) {
            await message.reply('📌 Você ainda não tem pedidos.\nDigite *link* para pedir! 🍕');
            return;
        }

        const pedido = await db.get(
            `SELECT p.*, m.nome as motoboy_nome 
             FROM pedidos p 
             LEFT JOIN motoboys m ON p.motoboy_id = m.id 
             WHERE p.cliente_id = ? 
             ORDER BY p.id DESC LIMIT 1`,
            [cliente.id]
        );

        if (!pedido) {
            await message.reply('📌 Você ainda não tem pedidos.\nDigite *link* para pedir! 🍕');
            return;
        }

        const statusEmoji = {
            'recebido': '📩', 'preparo': '👨‍🍳', 'saiu': '🚀',
            'entregue': '✅', 'cancelado': '❌'
        };
        const statusMap = {
            'recebido': 'Pedido Recebido', 'preparo': 'Em Preparo',
            'saiu': 'Saiu para Entrega', 'entregue': 'Pedido Entregue',
            'cancelado': 'Cancelado'
        };

        let mensagem =
            `📦 *Status do Pedido #${pedido.numero_pedido}*\n\n` +
            `${statusEmoji[pedido.status] || '📌'} *${statusMap[pedido.status] || pedido.status}*\n\n` +
            `📅 ${new Date(pedido.data_pedido).toLocaleString()}\n` +
            `💰 R$ ${pedido.total.toFixed(2)}`;

        if (pedido.motoboy_nome) mensagem += `\n🛵 *Entregador:* ${pedido.motoboy_nome}`;
        if (pedido.status === 'saiu') mensagem += `\n\n🚀 *Seu pedido está a caminho!*`;

        await message.reply(mensagem);

    } catch (error) {
        console.error('❌ Erro:', error);
        await message.reply('❌ Erro ao verificar status.');
    }
}

// ============================================
// ROTAS DA API
// ============================================

// 🔑 ROTA: Retorna a API Key para o frontend
app.get('/api/config', (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ erro: 'API Key não configurada no servidor' });
    }
    res.json({
        apiKey: apiKey,
        voice: 'Zubenelgenubi',
        model: 'gemini-3.1-flash-live-preview'
    });
});

// Gerar link via API
app.get('/api/link/:telefone', async (req, res) => {
    try {
        const telefone = req.params.telefone.replace(/\D/g, '');
        if (telefone.length < 10) return res.status(400).json({ erro: 'Telefone inválido' });

        let cliente = await db.get('SELECT * FROM clientes WHERE telefone = ?', [telefone]);
        if (!cliente) {
            await db.run('INSERT INTO clientes (telefone) VALUES (?)', [telefone]);
            cliente = await db.get('SELECT * FROM clientes WHERE telefone = ?', [telefone]);
        }

        const token = Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15);

        await db.run(
            'INSERT OR REPLACE INTO tokens_whatsapp (telefone, token) VALUES (?, ?)',
            [telefone, token]
        );

        res.json({
            sucesso: true,
            link: `${URL_BASE}/pedido?tel=${telefone}&token=${token}`,
            token: token,
            cliente: cliente
        });

    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// Clientes
app.get('/api/clientes', async (req, res) => {
    try {
        const clientes = await db.all(`
            SELECT c.*, 
                   (SELECT COUNT(*) FROM pedidos WHERE cliente_id = c.id) as total_pedidos,
                   (SELECT SUM(total) FROM pedidos WHERE cliente_id = c.id) as total_gasto
            FROM clientes c
            ORDER BY c.data_cadastro DESC
        `);
        res.json(clientes);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

app.get('/api/clientes/:id', async (req, res) => {
    try {
        const cliente = await db.get('SELECT * FROM clientes WHERE id = ?', [req.params.id]);
        if (!cliente) return res.status(404).json({ erro: 'Cliente não encontrado' });
        res.json(cliente);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

app.put('/api/clientes/:id', async (req, res) => {
    try {
        const { nome, endereco, numero, bairro, cidade, complemento, cep } = req.body;
        await db.run(
            `UPDATE clientes 
             SET nome = ?, endereco = ?, numero = ?, bairro = ?, cidade = ?, complemento = ?, cep = ?
             WHERE id = ?`,
            [nome, endereco, numero, bairro, cidade, complemento, cep, req.params.id]
        );
        res.json({ sucesso: true });
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// Pedidos
app.get('/api/pedidos', async (req, res) => {
    try {
        const pedidos = await db.all(`
            SELECT p.*, c.nome as cliente_nome, c.telefone as cliente_telefone,
                   m.nome as motoboy_nome
            FROM pedidos p
            LEFT JOIN clientes c ON p.cliente_id = c.id
            LEFT JOIN motoboys m ON p.motoboy_id = m.id
            ORDER BY p.id DESC
        `);
        res.json(pedidos);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

app.get('/api/pedidos/:id', async (req, res) => {
    try {
        const pedido = await db.get(`
            SELECT p.*, c.nome as cliente_nome, c.telefone as cliente_telefone,
                   m.nome as motoboy_nome
            FROM pedidos p
            LEFT JOIN clientes c ON p.cliente_id = c.id
            LEFT JOIN motoboys m ON p.motoboy_id = m.id
            WHERE p.id = ?
        `, [req.params.id]);
        if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });
        res.json(pedido);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

app.post('/api/pedidos', async (req, res) => {
    try {
        const { cliente_id, itens, total, forma_pagamento, endereco_entrega, observacao } = req.body;
        const numero_pedido = Math.floor(10000 + Math.random() * 90000);

        const result = await db.run(
            `INSERT INTO pedidos (numero_pedido, cliente_id, itens, total, forma_pagamento, endereco_entrega, observacao)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [numero_pedido, cliente_id, itens, total, forma_pagamento, endereco_entrega, observacao]
        );

        await db.run(
            'UPDATE clientes SET ultimo_pedido = CURRENT_TIMESTAMP WHERE id = ?',
            [cliente_id]
        );

        // Notifica cliente via WhatsApp (só se estiver ativo)
        if (whatsappReady && cliente_id) {
            const cliente = await db.get('SELECT telefone FROM clientes WHERE id = ?', [cliente_id]);
            if (cliente && cliente.telefone) {
                try {
                    const chatId = cliente.telefone.includes('@c.us') ? cliente.telefone : `${cliente.telefone}@c.us`;
                    await whatsappClient.sendMessage(chatId,
                        `✅ *Pedido #${numero_pedido} confirmado!*\n\n` +
                        `💰 Total: R$ ${total.toFixed(2)}\n` +
                        `💳 Pagamento: ${forma_pagamento.toUpperCase()}\n` +
                        `📍 Entrega: ${endereco_entrega}`
                    );
                } catch (e) {
                    console.warn('⚠️ Não conseguiu notificar WhatsApp');
                }
            }
        }

        res.json({ sucesso: true, pedido: { id: result.lastID, numero_pedido } });

    } catch (error) {
        console.error('❌ Erro:', error);
        res.status(500).json({ erro: error.message });
    }
});

app.put('/api/pedidos/:id/status', async (req, res) => {
    try {
        const { status, motoboy_id, observacao } = req.body;

        await db.run(
            'UPDATE pedidos SET status = ?, motoboy_id = ? WHERE id = ?',
            [status, motoboy_id || null, req.params.id]
        );

        await db.run(
            `INSERT INTO historico_status (pedido_id, status, observacao) VALUES (?, ?, ?)`,
            [req.params.id, status, observacao || '']
        );

        if (status === 'entregue') {
            await db.run(
                'UPDATE pedidos SET data_entrega = CURRENT_TIMESTAMP WHERE id = ?',
                [req.params.id]
            );
        }

        // Notifica cliente via WhatsApp
        if (whatsappReady) {
            const pedido = await db.get(`
                SELECT p.*, c.telefone as cliente_telefone 
                FROM pedidos p 
                LEFT JOIN clientes c ON p.cliente_id = c.id 
                WHERE p.id = ?
            `, [req.params.id]);

            if (pedido && pedido.cliente_telefone) {
                const statusMsg = {
                    'preparo': '👨‍🍳 Seu pedido está sendo preparado!',
                    'saiu': '🚀 Seu pedido saiu para entrega!',
                    'entregue': '✅ Seu pedido foi entregue! Obrigado! 🎉'
                };
                if (statusMsg[status]) {
                    try {
                        const chatId = pedido.cliente_telefone.includes('@c.us')
                            ? pedido.cliente_telefone
                            : `${pedido.cliente_telefone}@c.us`;
                        await whatsappClient.sendMessage(chatId,
                            `📦 *Pedido #${pedido.numero_pedido}*\n\n${statusMsg[status]}`
                        );
                    } catch (e) {}
                }
            }
        }

        res.json({ sucesso: true });
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// Motoboys
app.get('/api/motoboys', async (req, res) => {
    try {
        const motoboys = await db.all('SELECT * FROM motoboys ORDER BY nome');
        res.json(motoboys);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

app.post('/api/motoboys', async (req, res) => {
    try {
        const { nome, telefone, veiculo, placa } = req.body;
        const result = await db.run(
            'INSERT INTO motoboys (nome, telefone, veiculo, placa) VALUES (?, ?, ?, ?)',
            [nome, telefone, veiculo, placa]
        );
        const motoboy = await db.get('SELECT * FROM motoboys WHERE id = ?', [result.lastID]);
        res.json({ sucesso: true, motoboy });
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

app.put('/api/motoboys/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        await db.run('UPDATE motoboys SET status = ? WHERE id = ?', [status, req.params.id]);
        res.json({ sucesso: true });
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// Dashboard
app.get('/api/dashboard', async (req, res) => {
    try {
        const totalHoje = await db.get(
            `SELECT COUNT(*) as total, COALESCE(SUM(total), 0) as faturamento
             FROM pedidos WHERE DATE(data_pedido) = DATE('now')`
        );

        const porStatus = await db.all(
            `SELECT status, COUNT(*) as total FROM pedidos GROUP BY status`
        );

        const ultimosPedidos = await db.all(`
            SELECT p.*, c.nome as cliente_nome 
            FROM pedidos p
            LEFT JOIN clientes c ON p.cliente_id = c.id
            ORDER BY p.id DESC LIMIT 10
        `);

        res.json({
            total_hoje: totalHoje.total || 0,
            faturamento_hoje: totalHoje.faturamento || 0,
            por_status: porStatus,
            ultimos_pedidos: ultimosPedidos
        });
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// Relatórios
app.get('/api/relatorios/vendas', async (req, res) => {
    try {
        const { periodo } = req.query;
        let filtro = '';
        switch (periodo) {
            case 'dia': filtro = "DATE(data_pedido) = DATE('now')"; break;
            case 'semana': filtro = "DATE(data_pedido) >= DATE('now', '-7 days')"; break;
            case 'mes': filtro = "DATE(data_pedido) >= DATE('now', '-30 days')"; break;
            default: filtro = "1=1";
        }
        const vendas = await db.all(`
            SELECT DATE(data_pedido) as data, COUNT(*) as total_pedidos,
                   COALESCE(SUM(total), 0) as total_vendas,
                   COALESCE(AVG(total), 0) as ticket_medio
            FROM pedidos WHERE ${filtro}
            GROUP BY DATE(data_pedido) ORDER BY data DESC
        `);
        res.json(vendas);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// Rota do totem (cliente acessa pelo link)
app.get('/pedido', async (req, res) => {
    try {
        const { tel, token } = req.query;

        if (tel) {
            let cliente = await db.get('SELECT * FROM clientes WHERE telefone = ?', [tel]);
            if (!cliente) {
                await db.run('INSERT INTO clientes (telefone) VALUES (?)', [tel]);
            }
        }

        res.sendFile(path.join(__dirname, 'public', 'index.html'));

    } catch (error) {
        res.status(500).send('Erro interno');
    }
});

// ============================================
// INICIAR SERVIDOR
// ============================================
async function startServer() {
    await initDatabase();

    // 🔥 SÓ INICIA WHATSAPP EM LOCAL
    if (!IS_PRODUCTION) {
        await initWhatsApp();
    } else {
        console.log('⚠️ WhatsApp desabilitado em produção');
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log('');
        console.log('════════════════════════════════════════════════════════');
        console.log('🚀 SERVIDOR PIZZARIA RODANDO!');
        console.log('════════════════════════════════════════════════════════');
        console.log(`🌍 Ambiente: ${IS_PRODUCTION ? 'PRODUÇÃO' : 'LOCAL'}`);
        console.log(`💻 Local:  http://localhost:${PORT}`);
        console.log(`📱 Rede:   http://${LOCAL_IP}:${PORT}`);
        console.log(`📊 Admin:  ${URL_BASE}/admin.html`);
        console.log(`🛵 Motoboy: ${URL_BASE}/motoboy.html`);
        console.log(`🍕 Totem:   ${URL_BASE}/pedido`);
        console.log('════════════════════════════════════════════════════════');
        console.log('');
    });
}

startServer();