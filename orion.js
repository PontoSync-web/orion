async function importarERBs() {
  if (!fs.existsSync(DATA_DIR)) {
    console.log('⚠️ Pasta /data não encontrada.');
    return;
  }

  const arquivos = fs.readdirSync(DATA_DIR).filter(f => 
    f.startsWith('erb_consolidado_final_part') && f.endsWith('.csv')
  );

  if (arquivos.length === 0) {
    console.log('⚠️ Nenhum arquivo ERB encontrado.');
    return;
  }

  console.log(`📂 Encontrados ${arquivos.length} arquivos.`);

  for (const arquivo of arquivos.sort()) {
    const caminho = path.join(DATA_DIR, arquivo);
    console.log(`🔍 Lendo ${arquivo}...`);

    let estacoes = {};
    let linhaAtual = 0;
    let erros = 0;

    await new Promise((resolve, reject) => {
      // Usa readline para processar linha por linha
      const readline = require('readline');
      const rl = readline.createInterface({
        input: fs.createReadStream(caminho, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });

      rl.on('line', (line) => {
        linhaAtual++;
        
        // Pula linhas vazias
        if (!line.trim()) return;

        // Pula linhas que são apenas cabeçalho (se existirem)
        if (line.toLowerCase().includes('id_estacao')) return;

        try {
          // Parse manual da linha (formato: "campo1","campo2",...)
          const valores = [];
          let campoAtual = '';
          let dentroAspas = false;
          let i = 0;

          while (i < line.length) {
            const char = line[i];
            
            if (char === '"') {
              if (dentroAspas && line[i+1] === '"') {
                // Escape: aspas duplas dentro do campo
                campoAtual += '"';
                i += 2;
                continue;
              } else if (dentroAspas) {
                // Fecha aspas
                dentroAspas = false;
              } else {
                // Abre aspas
                dentroAspas = true;
              }
            } else if (char === ',' && !dentroAspas) {
              // Fim do campo
              valores.push(campoAtual.trim());
              campoAtual = '';
            } else {
              campoAtual += char;
            }
            i++;
          }
          // Último campo
          valores.push(campoAtual.trim());

          // Mapeamento baseado na posição
          const id = valores[0] || '';
          if (!id) {
            erros++;
            return;
          }

          const lat = parseFloat(valores[10] || 0);
          const lon = parseFloat(valores[11] || 0);
          
          // Valida coordenadas (Brasil)
          if (isNaN(lat) || isNaN(lon) || lat < -34 || lat > 6 || lon < -75 || lon > -33) {
            return;
          }

          if (!estacoes[id]) {
            estacoes[id] = {
              id_estacao: id,
              operadora: valores[1] || '',
              uf: valores[2] || '',
              municipio: valores[3] || '',
              bairro: valores[4] || '',
              endereco: valores[5] || '',
              codigo_municipio_ibge: valores[6] || '',
              latitude: lat,
              longitude: lon,
              tecnologias: valores[8] || '',
              frequencias: valores[9] || '',
              azimutes: '',
              emissoes: valores[25] || '',
              fonte: 'OpenCellID + Anatel',
              opencellid_radio: valores[12] || '',
              opencellid_cell: valores[16] || '',
              opencellid_correspondencia: valores[21] || '',
              anatel_correspondencia: valores[27] || ''
            };
          }
        } catch (err) {
          erros++;
          // Loga apenas alguns erros para não poluir
          if (erros <= 5) {
            console.log(`   ⚠️ Erro na linha ${linhaAtual}: ${err.message}`);
          }
        }
      });

      rl.on('close', () => {
        const qtd = Object.keys(estacoes).length;
        console.log(`✅ ${arquivo}: ${linhaAtual} linhas lidas, ${qtd} estações importadas.`);

        if (qtd > 0) {
          const stmt = db.prepare(`
            INSERT OR REPLACE INTO estacoes (
              id_estacao, operadora, uf, municipio, bairro, endereco,
              codigo_municipio_ibge, latitude, longitude, tecnologias,
              frequencias, azimutes, emissoes, fonte,
              opencellid_radio, opencellid_cell, opencellid_correspondencia, anatel_correspondencia
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const id in estacoes) {
            const e = estacoes[id];
            stmt.run(
              e.id_estacao, e.operadora, e.uf, e.municipio, e.bairro, e.endereco,
              e.codigo_municipio_ibge, e.latitude, e.longitude, e.tecnologias,
              e.frequencias, e.azimutes, e.emissoes, e.fonte,
              e.opencellid_radio, e.opencellid_cell, e.opencellid_correspondencia, e.anatel_correspondencia
            );
          }

          stmt.finalize();
        }

        const logStmt = db.prepare(`
          INSERT INTO importacao_log (arquivo, registros_lidos, registros_importados)
          VALUES (?, ?, ?)
        `);
        logStmt.run(arquivo, linhaAtual, qtd);
        logStmt.finalize();

        resolve();
      });

      rl.on('error', (err) => {
        console.error(`❌ Erro ao ler ${arquivo}:`, err);
        reject(err);
      });
    });
  }
  console.log('✅ Importação concluída.');
}
