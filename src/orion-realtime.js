// ORION RealTime v1.0
const sqlite3 = require('sqlite3').verbose();

class OrionRealTime {
  constructor(options) {
    this.dbMain = options.dbMain;
    this.dbTowers = options.dbTowers;
    this.buscasAtivas = new Map();
  }

  async localizar(numero) {
    const target = await this.buscarAlvo(numero);
    if (!target) return { erro: 'Alvo não cadastrado' };

    const ultima = await this.buscarUltimaLocalizacao(target.id);
    if (ultima && this.isRecente(ultima.timestamp, 24)) {
      return {
        status: 'sucesso',
        numero,
        alvo: target.name,
        position: { latitude: ultima.latitude, longitude: ultima.longitude, raio_estimado: ultima.radius },
        timestamp: ultima.timestamp,
        fonte: 'histórico_real'
      };
    }

    return { status: 'indisponivel', mensagem: 'Sem dados reais. Necessário envio de Cell IDs.' };
  }

  buscarAlvo(numero) {
    return new Promise((resolve) => {
      this.dbMain.get('SELECT * FROM targets WHERE phone = ?', [numero], (err, row) => resolve(row || null));
    });
  }

  buscarUltimaLocalizacao(targetId) {
    return new Promise((resolve) => {
      this.dbMain.get('SELECT * FROM locations WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1', [targetId], (err, row) => resolve(row || null));
    });
  }

  isRecente(timestamp, horas) {
    return (Date.now() - new Date(timestamp).getTime()) < horas * 3600000;
  }
}

module.exports = OrionRealTime;
