/**
 * Utility: sanitize-path.js
 * Prevent path traversal and validate repository paths used in GitHub API calls.
 */

const path = require('path');

function sanitizePath(caminho) {
  if (!caminho || typeof caminho !== 'string') throw new Error('Caminho inválido');
  // Normaliza como POSIX (GitHub usa '/'). Garante que não haja /../ que saia da raiz.
  const normalized = path.posix.normalize('/' + caminho).replace(/^\/+/, '');
  if (normalized === '' || normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error('Caminho inválido');
  }
  if (normalized.length > 400) throw new Error('Caminho muito longo');
  return normalized;
}

module.exports = { sanitizePath };