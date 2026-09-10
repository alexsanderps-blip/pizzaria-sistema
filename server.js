// ============================================
// SERVIDOR PRINCIPAL - PIZZARIA + WHATSAPP + TOTEM
// ============================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const os = require('os');
const fs = require('fs');
const path = require('path');

let db;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.get('/api/config', (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
        return res.status(500).json({ 
            erro: 'API Key não configurada no servidor. Configure a variável GEMINI_API_KEY.' 
        });
    }
    
    res.json({ 
        apiKey: apiKey,
        voice: 'Zubenelgenubi',
        model: 'gemini-3.1-flash-live-preview'
    });
});
// ============================================
// DESCOBRE O IP DA REDE LOCAL AUTOMATICAMENTE
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
const URL_BASE = `http://${LOCAL_IP}:${PORT}`;

// ============================================
// BANCO DE DADOS SQLITE
// ============================================
let db;

async function initDatabase() {
    const dbDir = path.join(__dirname, 'database');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        console.log('📁 Pasta database/ criada');
    }
    
    db = await open({
        filename: './database/pizzaria.db',
        driver: sqlite3.Database
    });

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

    await db.exec(`
        CREATE TABLE IF NOT EXISTS tokens_whatsapp (
            telefone TEXT PRIMARY KEY,
            token TEXT UNIQUE NOT NULL,
            data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
            data_uso DATETIME
        )
    `);

    console.log('✅ Banco de dados SQLite inicializado!');
}

// ============================================
// WHATSAPP CLIENT
// ============================================
let whatsappClient = null;
let whatsappReady = false;

async function initWhatsApp() {
    try {
        whatsappClient = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

        whatsappClient.on('qr', qr => {
            console.log('📱 Escaneie o QR Code para conectar o WhatsApp:');
            qrcode.generate(qr, { small: true });
        });

        whatsappClient.on('ready', () => {
            whatsappReady = true;
            console.log('✅ WhatsApp conectado!');
        });

        whatsappClient.on('message', async message => {
            await processarMensagemWhatsApp(message);
        });

        whatsappClient.initialize();
        console.log('🔄 Iniciando WhatsApp...');
    } catch (error) {
        console.error('❌ Erro ao iniciar WhatsApp:', error);
    }
}

// ============================================
// PROCESSAR MENSAGENS DO WHATSAPP
// ============================================
async function processarMensagemWhatsApp(message) {
    if (message.from.includes('g.us')) return;

    const telefone = message.from.replace('@c.us', '');
    const texto = message.body.toLowerCase().trim();

    console.log(`📩 Mensagem de ${telefone}: ${texto}`);

    // Comando: LINK
    if (texto === 'link' || texto === 'comprar' || texto === 'pedido') {
        await gerarLinkCompra(telefone, message);
        return;
    }

    // Comando: STATUS
    if (texto === 'status' || texto === 'meu pedido') {
        await verificarStatusPedido(telefone, message);
        return;
    }

    // Comando: AJUDA
    if (texto === 'ajuda' || texto === 'help' || texto === 'oi' || texto === 'olá' || texto === 'ola') {
        await message.reply(
            `🍕 *Pizzaria do Zé*\n\n` +
            `Olá! 👋 Como posso ajudar?\n\n` +
            `📌 Digite *link* para fazer seu pedido\n` +
            `📌 Digite *status* para acompanhar\n` +
            `📌 Digite *ajuda* para ver os comandos\n\n` +
            `🔗 Ou acesse diretamente: ${URL_BASE}/pedido?tel=${telefone}`
        );
        return;
    }

    // Mensagem padrão
    await message.reply(
        `🍕 *Pizzaria do Zé*\n\n` +
        `Olá! 👋\n\n` +
        `📌 Digite *link* para fazer seu pedido\n` +
        `📌 Digite *status* para acompanhar\n` +
        `📌 Digite *ajuda* para ver os comandos\n\n` +
        `🔗 Ou acesse diretamente: ${URL_BASE}/pedido?tel=${telefone}`
    );
}

// ============================================
// GERAR LINK DE COMPRA (para o totem)
// ============================================
async function gerarLinkCompra(telefone, message) {
    try {
        let cliente = await db.get('SELECT * FROM clientes WHERE telefone = ?', [telefone]);

        if (!cliente) {
            await db.run('INSERT INTO clientes (telefone, nome) VALUES (?, ?)',
                [telefone, `Cliente ${telefone.slice(-4)}`]);
            cliente = await db.get('SELECT * FROM clientes WHERE telefone = ?', [telefone]);
        }

        // Gera token único
        const token = Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15);

        await db.run(
            'INSERT OR REPLACE INTO tokens_whatsapp (telefone, token) VALUES (?, ?)',
            [telefone, token]
        );

        // 🔥 LINK DO TOTEM COM O TELEFONE
        const linkPedido = `${URL_BASE}/pedido?tel=${telefone}&token=${token}`;

        let mensagemEndereco = '';
        if (cliente.endereco) {
            mensagemEndereco =
                `\n\n📍 *Endereço cadastrado:*\n${cliente.endereco}, ${cliente.numero}\n${cliente.bairro} - ${cliente.cidade}`;
        }

        await message.reply(
            `🍕 *Link para fazer seu pedido!*\n\n` +
            `🔗 Clique no link abaixo:\n${linkPedido}\n\n` +
            `💡 *Dica:* Salve este link para pedir mais rápido!${mensagemEndereco}\n\n` +
            `📌 Quando fizer o pedido, você pode confirmar ou alterar o endereço.`
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
            await message.reply(
                '📌 Você ainda não tem pedidos registrados.\n' +
                'Digite *link* para fazer seu primeiro pedido! 🍕'
            );
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
            await message.reply(
                '📌 Você ainda não tem pedidos.\n' +
                'Digite *link* para fazer seu pedido! 🍕'
            );
            return;
        }

        const statusEmoji = {
            'recebido': '📩',
            'preparo': '👨‍🍳',
            'saiu': '🚀',
            'entregue': '✅',
            'cancelado': '❌'
        };

        const statusMap = {
            'recebido': 'Pedido Recebido',
            'preparo': 'Em Preparo',
            'saiu': 'Saiu para Entrega',
            'entregue': 'Pedido Entregue',
            'cancelado': 'Pedido Cancelado'
        };

        let mensagem =
            `📦 *Status do Pedido #${pedido.numero_pedido}*\n\n` +
            `${statusEmoji[pedido.status] || '📌'} *${statusMap[pedido.status] || pedido.status}*\n\n` +
            `📅 ${new Date(pedido.data_pedido).toLocaleString()}\n` +
            `💰 R$ ${pedido.total.toFixed(2)}`;

        if (pedido.motoboy_nome) {
            mensagem += `\n🛵 *Entregador:* ${pedido.motoboy_nome}`;
        }

        if (pedido.status === 'saiu') {
            mensagem += `\n\n🚀 *Seu pedido está a caminho!*`;
        }

        if (pedido.status === 'entregue') {
            mensagem += `\n\n✅ *Pedido entregue! Obrigado! 🎉*`;
        }

        await message.reply(mensagem);

    } catch (error) {
        console.error('❌ Erro ao verificar status:', error);
        await message.reply('❌ Erro ao verificar status. Tente novamente.');
    }
}

// ============================================
// ROTAS DA API
// ============================================

// Link via API
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
        console.error('❌ Erro:', error);
        res.status(500).json({ erro: 'Erro interno' });
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

        // 🔥 ENVIA NOTIFICAÇÃO PELO WHATSAPP
        const cliente = await db.get('SELECT telefone FROM clientes WHERE id = ?', [cliente_id]);
        if (cliente && whatsappReady) {
            await enviarMensagemWhatsApp(cliente.telefone,
                `✅ *Pedido #${numero_pedido} confirmado!*\n\n` +
                `💰 Total: R$ ${total.toFixed(2)}\n` +
                `💳 Pagamento: ${forma_pagamento.toUpperCase()}\n` +
                `📍 Entrega: ${endereco_entrega}\n\n` +
                `👨‍🍳 Seu pedido já está sendo preparado!\n` +
                `Digite *status* para acompanhar.`
            );
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

        if (status === 'entregue') {
            await db.run(
                'UPDATE pedidos SET data_entrega = CURRENT_TIMESTAMP WHERE id = ?',
                [req.params.id]
            );
        }

        // 🔥 NOTIFICA O CLIENTE SOBRE MUDANÇA DE STATUS
        const pedido = await db.get(`
            SELECT p.*, c.telefone as cliente_telefone 
            FROM pedidos p 
            LEFT JOIN clientes c ON p.cliente_id = c.id 
            WHERE p.id = ?
        `, [req.params.id]);

        if (pedido && pedido.cliente_telefone && whatsappReady) {
            const statusMsg = {
                'preparo': '👨‍🍳 Seu pedido está sendo preparado!',
                'saiu': '🚀 Seu pedido saiu para entrega!',
                'entregue': '✅ Seu pedido foi entregue! Obrigado! 🎉'
            };

            if (statusMsg[status]) {
                await enviarMensagemWhatsApp(pedido.cliente_telefone,
                    `📦 *Pedido #${pedido.numero_pedido}*\n\n${statusMsg[status]}`
                );
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

// ============================================
// ROTA: TOTEM (cliente acessa pelo link)
// ============================================
app.get('/pedido', async (req, res) => {
    try {
        const { tel, token } = req.query;

        // Se veio telefone, salva no cliente
        if (tel) {
            let cliente = await db.get('SELECT * FROM clientes WHERE telefone = ?', [tel]);
            if (!cliente) {
                await db.run('INSERT INTO clientes (telefone) VALUES (?)', [tel]);
            }
        }

        // Envia o HTML do totem
        res.sendFile(path.join(__dirname, 'public', 'index.html'));

    } catch (error) {
        console.error('❌ Erro:', error);
        res.status(500).send('Erro interno');
    }
});

// ============================================
// INICIAR SERVIDOR
// ============================================
async function startServer() {
    await initDatabase();
    await initWhatsApp();

    app.listen(PORT, '0.0.0.0', () => {
        console.log('');
        console.log('════════════════════════════════════════════════════════');
        console.log('🚀 SERVIDOR PIZZARIA RODANDO!');
        console.log('════════════════════════════════════════════════════════');
        console.log(`💻 PC (local):    http://localhost:${PORT}`);
        console.log(`📱 iPhone (rede): http://${LOCAL_IP}:${PORT}`);
        console.log(`📊 Admin:         http://${LOCAL_IP}:${PORT}/admin.html`);
        console.log(`🛵 Motoboy:       http://${LOCAL_IP}:${PORT}/motoboy.html`);
        console.log(`🍕 Totem:         http://${LOCAL_IP}:${PORT}/pedido?tel=5511999999999`);
        console.log('════════════════════════════════════════════════════════');
        console.log('');
        console.log('⚠️  IMPORTANTE:');
        console.log('   • Para o MICROFONE funcionar no iPhone,');
        console.log('     você PRECISA de HTTPS. Use ngrok:');
        console.log('     ngrok http 3000');
        console.log('');
    });
}

startServer();