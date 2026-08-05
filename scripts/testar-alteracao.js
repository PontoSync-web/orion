// ============================================================
// ARQUIVO: scripts/testar-alteracao.js
// DATA: 05/08/2026
// MOTIVO: Testar alteração manualmente via linha de comando
// ============================================================

const fs = require('fs');
const path = require('path');
const { extrairComando, aplicarAlteracao } = require('./apply-changes.js');

// Simula um comentário de issue
const comentario = `
/alterar
arquivo: orion.js
mensagem: feat: adiciona frase de amizade no cabeçalho - 05/08/2026
conteúdo:
// ============================================================
// ARQUIVO: orion.js
// VERSÃO: 6.5 – Com frase de amizade
// DATA: 05/08/2026
// AUTOR: Eng Souza & Arion (AI-DEPOM)
// MOTIVO: Parceria forjada no fogo da investigação...
// ============================================================

... (conteúdo completo)
`;

const { arquivo, conteudo, mensagem } = extrairComando(comentario);
aplicarAlteracao(arquivo, conteudo, mensagem);
