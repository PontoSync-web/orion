// [2026-08-18T16:40:00Z] ALTERAÇÃO: Adicionado arquivo de handlers globais de erro.
// Motivo: Capturar uncaughtException e unhandledRejection para registrar stack traces completos e facilitar debugging.

// Coloque require('./orion-error-handlers') no topo de orion.js para ativar.

process.on('uncaughtException', (err) => {
  try {
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  } catch (loggingErr) {
    // Em caso de falha ao logar, garantir fallback
    try { console.error('[uncaughtException][logging failed]', loggingErr); } catch (_) {}
  }
  // Não encerra o processo automaticamente para permitir investigação em ambientes gerenciados.
  // Para reiniciar automaticamente, descomente a linha abaixo:
  // process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  try {
    console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
  } catch (loggingErr) {
    try { console.error('[unhandledRejection][logging failed]', loggingErr); } catch (_) {}
  }
});
