/**
 * ===================================================================
 * ORION - SCRIPT DE IMPORTAÇÃO DE ERBS
 * ===================================================================
 * Data: 03/09/2026
 * Autor: Eng. Itamar Souza
 * 
 * Descrição: Importa os arquivos CSV consolidados para o Supabase
 * ===================================================================
 */

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { createClient } = require('@supabase/supabase-js');

// ============================================================
// CONFIGURAÇÃO
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL || 'https://apjjuocqpqxaehbcagwt.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwamp1b2NxcHF4YWVoYmNhZ3d0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5NDc1MzYsImV4cCI6MjEwMzUyMzUzNn0.yEaocmm4XPb6_XT8_qk6O3JyWA1LV-NwoTkCwBs96Mc';
const supabase = createClient(supabaseUrl, supabaseKey);

const DATA_DIR = path.join(__dirname, '../data');

// ============================================================
// FUNÇÃO PARA IMPORTAR UM ARQUIVO CSV
// ============================================================
async function importarCSV(nomeArquivo) {
    const caminho = path.join(DATA_DIR, nomeArquivo);
    console.log(`🔍 Lendo ${nomeArquivo}...`);

    return new Promise((resolve, reject) => {
        const torres = [];
        let contador = 0;

        fs.createReadStream(caminho)
            .pipe(csv())
            .on('data', (row) => {
                contador++;
                if (contador % 10000 === 0) {
                    console.log(`   ⏳ Processadas ${contador} linhas...`);
                }

                // Mapear colunas do CSV para a tabela erbs
                const torre = {
                    cell_id: row.cell_id || row.CELL_ID || row.cellId || 'N/A',
                    operadora: row.operadora || row.OPERADORA || 'N/A',
                    lat: parseFloat(row.lat || row.LAT || 0),
                    lng: parseFloat(row.lng || row.LNG || 0),
                    rsrp: parseInt(row.rsrp || row.RSRP || 0),
                    sinr: parseInt(row.sinr || row.SINR || 0),
                    uf: row.uf || row.UF || '',
                    municipio: row.municipio || row.MUNICIPIO || '',
                    endereco: row.endereco || row.ENDERECO || '',
                    bairro: row.bairro || row.BAIRRO || '',
                    setor: row.setor || row.SETOR || '',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                };

                torres.push(torre);
            })
            .on('end', async () => {
                console.log(`   ✅ ${nomeArquivo}: ${torres.length} linhas lidas.`);
                
                try {
                    // Inserir em lotes de 1000
                    const batchSize = 1000;
                    let inseridos = 0;
                    
                    for (let i = 0; i < torres.length; i += batchSize) {
                        const batch = torres.slice(i, i + batchSize);
                        const { data, error } = await supabase
                            .from('erbs')
                            .insert(batch);

                        if (error) {
                            console.error(`   ❌ Erro ao inserir lote ${i/batchSize + 1}:`, error.message);
                            continue;
                        }

                        inseridos += batch.length;
                        console.log(`   ✅ ${inseridos} estações inseridas...`);
                    }

                    console.log(`   ✅ ${nomeArquivo}: ${inseridos} estações importadas.`);
                    resolve(inseridos);
                } catch (error) {
                    console.error(`   ❌ Erro ao importar ${nomeArquivo}:`, error);
                    reject(error);
                }
            })
            .on('error', (error) => {
                console.error(`   ❌ Erro ao ler ${nomeArquivo}:`, error);
                reject(error);
            });
    });
}

// ============================================================
// FUNÇÃO PRINCIPAL
// ============================================================
async function main() {
    console.log('📡 Iniciando importação das ERBs...');
    console.log('='.repeat(60));

    try {
        const arquivos = [
            'erb_consolidado_final_part1.csv',
            'erb_consolidado_final_part2.csv'
        ];

        let total = 0;

        for (const arquivo of arquivos) {
            const count = await importarCSV(arquivo);
            total += count;
        }

        console.log('='.repeat(60));
        console.log(`✅ TOTAL: ${total} torres importadas com sucesso!`);

        // Verificar total no banco
        const { count, error } = await supabase
            .from('erbs')
            .select('*', { count: 'exact', head: true });

        if (error) {
            console.error('❌ Erro ao verificar total:', error);
        } else {
            console.log(`📊 Total no banco: ${count} torres`);
        }

    } catch (error) {
        console.error('❌ Erro na importação:', error);
    }
}

// ============================================================
// EXECUTAR
// ============================================================
main();
