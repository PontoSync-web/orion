*** Begin Patch
*** Update File: orion.js
@@
-const express = require('express');
-const sqlite3 = require('sqlite3').verbose();
-const fs = require('fs');
-const path = require('path');
-const { exec } = require('child_process');
+const express = require('express');
+const sqlite3 = require('sqlite3').verbose();
+const fs = require('fs');
+const path = require('path');
+const { exec } = require('child_process');
+const { sanitizePath } = require('./utils/sanitize-path');
+
+// GitHub repository owner/repo - keep configurable via env
+const GITHUB_OWNER = process.env.GITHUB_OWNER || 'souza-oliveira-br-max';
+const GITHUB_REPO = process.env.GITHUB_REPO || 'ORION';
@@
 app.get('/mapa-localizar.html', (req, res) => {
@@
 });
+
+async function getDefaultBranch(owner, repo, token) {
+    const url = `https://api.github.com/repos/${owner}/${repo}`;
+    const resp = await fetch(url, {
+        headers: {
+            'Authorization': `token ${token}`,
+            'User-Agent': 'ORION-AI-DEPOM',
+            'Accept': 'application/vnd.github+json'
+        }
+    });
+    if (!resp.ok) throw new Error(`GitHub API: ${resp.status} ${resp.statusText}`);
+    const data = await resp.json();
+    return data.default_branch;
+}
*** End Patch
