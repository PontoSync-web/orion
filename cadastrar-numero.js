// cadastrar-numero.js — ORION AI-DEPOM
// Script universal para cadastrar números dinamicamente
// Criado em: 2026-08-26
// Atualizado em: 2026-08-26 17:00 BRT — Removidos números fixos
// =====================================================================

'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 2026-08-26 — Caminho do banco de dados
const DB_PATH = path.join(__dirname, 'orion.db');

// 2026-08-26 — Verificar argumentos passados pelo terminal
const args = process.argv.slice(2);
const TELEFONE = args[0];     // Primeiro argumento: número
const OPERADORA = args[1] || 'TIM'; // Segundo argumento: operadora (opcional)
const NOME = args[2] || 'Não informado'; // Terceiro argumento: nome (opcional)

// 2026-08-26 — Validar se o número foi fornecido
if (!TELEFONE) {
    console.error('❌ Erro: Número de telefone não fornecido.');
    console.error('Uso: node cadastrar-numero.js <telefone> [operadora] [nome]');
    console.error('Exemplo: node cadastrar-numero.js 71988979724 TIM "Investigador Souza"');
    process.exit(1);
}

// 2026-08-26 — Conectar ao banco SQLite
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Erro ao conectar ao banco:', err.message);
        process.exit(1);
    }
    console.log('✅ Conectado ao SQLite:', DB_PATH);
});

// 2026-08-26 — Criar tabela se não existir
function criarTabela() {
    return new Promise((resolve, reject) => {
        const sql = `
            CREATE TABLE IF NOT EXISTS numeros (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telefone TEXT UNIQUE NOT NULL,
                operadora TEXT,
                pais TEXT DEFAULT 'BR',
                nome TEXT,
                observacao TEXT,
                criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;
        db.run(sql, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// 2026-08-26 — Cadastrar o número dinamicamente
function cadastrarNumero(telefone, operadora, nome) {
    return new Promise((resolve, reject) => {
        const sql = `
            INSERT OR REPLACE INTO numeros (telefone, operadora, pais, nome)
            VALUES (?, ?, 'BR', ?)
        `;
        db.run(sql, [telefone, operadora, nome], function(err) {
            if (err) reject(err);
            else resolve(this.changes);
        });
    });
}

// 2026-08-26 — Verificar se o número foi cadastrado
function verificarNumero(telefone) {
    return new Promise((resolve, reject) => {
        const sql = 'SELECT * FROM numeros WHERE telefone = ?';
        db.get(sql, [telefone], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// 2026-08-26 — Função principal
async function main() {
    try {
        console.log('\n🔧 Iniciando cadastro dinâmico...\n');
        console.log(`📱 Telefone: ${TELEFONE}`);
        console.log(`🏢 Operadora: ${OPERADORA}`);
        console.log(`👤 Nome: ${NOME}\n`);

        // 1. Criar tabela
        await criarTabela();
        console.log('✅ Tabela "numeros" pronta.');

        // 2. Cadastrar número
        const mudancas = await cadastrarNumero(TELEFONE, OPERADORA, NOME);
        console.log(`✅ Número cadastrado com sucesso (${mudancas} registro(s)).`);

        // 3. Verificar
        const registro = await verificarNumero(TELEFONE);
        if (registro) {
            console.log('\n📊 Dados cadastrados:');
            console.log(JSON.stringify(registro, null, 2));
        }

        console.log('\n🎯 Cadastro concluído. Acesse o mapa e digite o número.\n');

        // 4. Fechar banco
        db.close((err) => {
            if (err) console.error('Erro ao fechar banco:', err.message);
            else console.log('✅ Banco fechado corretamente.');
        });

    } catch (err) {
        console.error('❌ Erro:', err.message);
        db.close();
        process.exit(1);
    }
}

// 2026-08-26 — Executar
main();
