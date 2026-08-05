// ============================================================
// ARQUIVO: scripts/apply-changes.js
// DATA: 05/08/2026
// MOTIVO: Aplicar alterações no ORION a partir de comandos
//         recebidos via issue comment.
// ============================================================

const fs = require('fs');
const path = require('path');

// Extrai o comando e o conteúdo do comentário
function extrairComando(comentario) {
    // Formato esperado:
    // /alterar
    // arquivo: orion.js
    // conteúdo: ...
    // mensagem: ...
    
    const linhas = comentario.split('\n');
    let arquivo = 'orion.js';
    let conteudo = '';
    let mensagem = 'Alteração automática via ORION - Arion';
    let encontrouConteudo = false;
    let conteudoLinhas = [];

    for (const linha of linhas) {
        const trimmed = linha.trim();
        if (trimmed.startsWith('arquivo:')) {
            arquivo = trimmed.replace('arquivo:', '').trim();
        } else if (trimmed.startsWith('mensagem:')) {
            mensagem = trimmed.replace('mensagem:', '').trim();
        } else if (trimmed.startsWith('conteúdo:') || trimmed.startsWith('conteudo:')) {
            encontrouConteudo = true;
            // O conteúdo começa na próxima linha
        } else if (encontrouConteudo) {
            if (trimmed.startsWith('---') || trimmed.startsWith('```')) {
                continue;
            }
            conteudoLinhas.push(trimmed);
        }
    }

    if (conteudoLinhas.length > 0) {
        conteudo = conteudoLinhas.join('\n');
    }

    return { arquivo, conteudo, mensagem };
}

// Salva a alteração no arquivo local e faz commit
function aplicarAlteracao(arquivo, conteudo, mensagem) {
    const caminho = path.join(__dirname, '..', arquivo);
    console.log(`[APPLY] Modificando ${caminho}...`);
    
    // Backup do arquivo original
    if (fs.existsSync(caminho)) {
        const backup = caminho + '.backup';
        fs.copyFileSync(caminho, backup);
        console.log(`[APPLY] Backup criado: ${backup}`);
    }

    // Escreve o novo conteúdo
    fs.writeFileSync(caminho, conteudo, 'utf8');
    console.log(`[APPLY] Arquivo ${arquivo} atualizado com sucesso.`);

    // Verifica se o conteúdo mudou
    const diff = require('child_process').execSync(`git diff --stat ${arquivo}`, { encoding: 'utf8' });
    if (diff.trim()) {
        console.log(`[APPLY] Alterações detectadas:\n${diff}`);
    } else {
        console.log(`[APPLY] Nenhuma alteração detectada.`);
    }
}

// Função principal
function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error('[APPLY] Nenhum comentário fornecido.');
        process.exit(1);
    }

    const comentario = args.join(' ');
    const { arquivo, conteudo, mensagem } = extrairComando(comentario);

    if (!conteudo) {
        console.error('[APPLY] Conteúdo não fornecido no comentário.');
        console.error('Formato esperado:');
        console.error('/alterar');
        console.error('arquivo: orion.js');
        console.error('conteúdo:');
        console.error('... conteúdo do arquivo ...');
        process.exit(1);
    }

    console.log(`[APPLY] Aplicando alteração:`);
    console.log(`  Arquivo: ${arquivo}`);
    console.log(`  Mensagem: ${mensagem}`);
    console.log(`  Tamanho do conteúdo: ${conteudo.length} caracteres`);

    aplicarAlteracao(arquivo, conteudo, mensagem);
}

// Exporta para uso em outros scripts
module.exports = { extrairComando, aplicarAlteracao };

if (require.main === module) {
    main();
}
