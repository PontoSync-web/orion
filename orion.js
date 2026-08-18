*** Begin Patch
*** Update File: orion.js
@@
-app.get('/api/repo/ler/:caminho(*)', async (req, res) => {
-    const caminho = req.params.caminho;
-    const token = process.env.GITHUB_TOKEN;
-    
-    if (!token) {
-        return res.status(500).json({ erro: 'GITHUB_TOKEN não configurado.' });
-    }
-
-    try {
-        const url = `https://api.github.com/repos/souza-oliveira-br-max/ORION/contents/${caminho}`;
-        const response = await fetch(url, {
-            headers: {
-                'Authorization': `token ${token}`,
-                'User-Agent': 'ORION-AI-DEPOM'
-            }
-        });
-
-        if (!response.ok) {
-            return res.status(response.status).json({ erro: `GitHub API: ${response.statusText}` });
-        }
-
-        const data = await response.json();
-        if (data.content) {
-            const conteudo = Buffer.from(data.content, 'base64').toString('utf8');
-            res.json({ 
-                status: 'sucesso', 
-                arquivo: caminho, 
-                conteudo: conteudo,
-                sha: data.sha,
-                tamanho: data.size
-            });
-        } else {
-            res.json({ status: 'vazio', mensagem: 'Arquivo vazio ou não encontrado.' });
-        }
-    } catch (err) {
-        log('error', 'Erro ao ler arquivo do GitHub: ' + err.message);
-        res.status(500).json({ erro: err.message });
-    }
-});
+app.get('/api/repo/ler/:caminho(*)', async (req, res) => {
+    let caminho;
+    try {
+        caminho = sanitizePath(req.params.caminho);
+    } catch (e) {
+        return res.status(400).json({ erro: e.message });
+    }
+
+    const token = process.env.GITHUB_TOKEN;
+    if (!token) return res.status(500).json({ erro: 'GITHUB_TOKEN não configurado.' });
+
+    try {
+        const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${caminho}`;
+        const response = await fetch(url, {
+            headers: {
+                'Authorization': `token ${token}`,
+                'User-Agent': 'ORION-AI-DEPOM',
+                'Accept': 'application/vnd.github.v3.raw+json'
+            }
+        });
+
+        if (!response.ok) {
+            return res.status(response.status).json({ erro: `GitHub API: ${response.statusText}` });
+        }
+
+        const data = await response.json();
+        if (data && data.content) {
+            const conteudo = Buffer.from(data.content, 'base64').toString('utf8');
+            res.json({ status: 'sucesso', arquivo: caminho, conteudo: conteudo, sha: data.sha, tamanho: data.size });
+        } else {
+            res.json({ status: 'vazio', mensagem: 'Arquivo vazio ou não encontrado.' });
+        }
+    } catch (err) {
+        log('error', 'Erro ao ler arquivo do GitHub: ' + err.message);
+        res.status(500).json({ erro: err.message });
+    }
+});
*** End Patch