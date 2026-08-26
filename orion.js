// =====================================================================
// orion.js — ORION AI-DEPOM — Sistema de Inteligência e Geocalização
// Criado em: 2026-08-26 14:00 BRT
// Última atualização: 2026-08-26 19:00 BRT
// Motivo: Corrigir erro "no such table: numeros" no deploy
// Alterações:
//   2026-08-26 19:00 — Adicionada criação automática da tabela numeros
//   2026-08-26 18:30 — Adicionada rota POST /api/cadastrar
//   2026-08-26 18:30 — Adicionada rota GET /api/localizar
//   2026-08-26 18:30 — Atualizada rota de arquivos estáticos
// =====================================================================

'use strict';

// 2026-08-26 19:00 — Dependências essenciais do ORION
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// 2026-08-26 19:00 — Inicializar o aplicativo Express
const app = express();
const PORT = process.env.PORT || 3000;

// 2026-08-26 19:00 — Caminho do banco de dados SQLite
const DB_PATH = path.join(__dirname, 'orion.db');

// 2026-08-26 19:00 — Conectar ao SQLite
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Erro ao conectar ao SQLite:', err.message);
        process.exit(1);
    }
    console.log('✅ Conectado ao SQLite:', DB_PATH);
});

// =====================================================================
// 2026-08-26 19:00 — CRIAÇÃO AUTOMÁTICA DA TABELA numeros
// Motivo: Evitar erro "no such table: numeros" no deploy
// =====================================================================
db.run(`
    CREATE TABLE IF NOT EXISTS numeros (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telefone TEXT UNIQUE NOT NULL,
        operadora TEXT,
        pais TEXT DEFAULT 'BR',
        nome TEXT,
        observacao TEXT,
        lat REAL,
        lng REAL,
        precision REAL DEFAULT 200,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`, (err) => {
    if (err) {
        console.error('Erro ao criar tabela numeros:', err.message);
        process.exit(1);
    }
    console.log('✅ Tabela "numeros" pronta.');
});

// 2026-08-26 19:00 — Middleware para JSON e arquivos estáticos
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =====================================================================
// 2026-08-26 19:00 — ROTA DE CADASTRO DE NÚMERO
// Descrição: Recebe telefone, operadora e nome via POST
//            e insere no SQLite com operação de upsert.
// =====================================================================
app.post('/api/cadastrar', (req, res) => {
    const { telefone, operadora, nome } = req.body;

    // 2026-08-26 19:00 — Validar entrada obrigatória
    if (!telefone) {
        return res.json({ success: false, message: 'Telefone obrigatório.' });
    }

    // 2026-08-26 19:00 — SQL de cadastro/atualização
    const sql = `
        INSERT OR REPLACE INTO numeros (telefone, operadora, pais, nome)
        VALUES (?, ?, 'BR', ?)
    `;

    db.run(sql, [telefone, operadora || 'TIM', nome || 'Não informado'], (err) => {
        if (err) {
            return res.json({ success: false, message: err.message });
        }
        res.json({ success: true });
    });
});

// =====================================================================
// 2026-08-26 19:00 — ROTA DE LOCALIZAÇÃO DE NÚMERO
// Descrição: Consulta o SQLite pelo telefone e retorna os dados
//            para exibição no mapa interativo.
// =====================================================================
app.get('/api/localizar', (req, res) => {
    const { telefone } = req.query;

    // 2026-08-26 19:00 — Validar entrada obrigatória
    if (!telefone) {
        return res.json({ success: false, message: 'Telefone obrigatório.' });
    }

    // 2026-08-26 19:00 — Consulta ao banco
    db.get('SELECT * FROM numeros WHERE telefone = ?', [telefone], (err, row) => {
        if (err) {
            return res.json({ success: false, message: err.message });
        }
        if (!row) {
            return res.json({ success: false, message: 'Número não encontrado na base de dados.' });
        }
        // 2026-08-26 19:00 — Retornar dados do número encontrado
        res.json({
            success: true,
            telefone: row.telefone,
            operadora: row.operadora,
            nome: row.nome,
            lat: row.lat || -12.9714,
            lng: row.lng || -38.5014,
            precision: row.precision || 200
        });
    });
});

// =====================================================================
// 2026-08-26 19:00 — ROTA PRINCIPAL
// Descrição: Serve a página do mapa interativo.
// =====================================================================
app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'mapa-localizar.html'));
});

// =====================================================================
// 2026-08-26 19:00 — INICIALIZAÇÃO DO SERVIDOR
// =====================================================================
app.listen(PORT, () => {
    console.log(`\n🚀 ORION AI-DEPOM — Servidor ativo`);
    console.log(`   http://localhost:${PORT}`);
    console.log('   Rotas:');
    console.log('   - POST /api/cadastrar');
    console.log('   - GET  /api/localizar');
    console.log('   - GET  / (mapa)\n');
});
