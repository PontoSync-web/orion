function requireAuth(req, res, next) {
 const auth = req.headers.authorization;

 if (!auth || !auth.startsWith('Bearer ')) {
 return res.status(401).json({ error: 'Não autenticado' });
 }

 const token = auth.slice(7);

 if (token !== 'orion-dev-token') {
 return res.status(401).json({ error: 'Token inválido' });
 }

 req.user = { id: 1, username: 'admin', role: 'admin' };
 next();
}

module.exports = { requireAuth };
