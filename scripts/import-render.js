*** Begin Patch
*** Update File: scripts/import-render.js
@@
-    if (!API_KEY) {
-        log('ERRO: Token OpenCellID nao configurado. Abortando.');
-        process.exit(1);
-    }
+    if (!API_KEY) {
+        // Não encerra o processo quando usado como módulo — lançar erro para o chamador tratar
+        const msg = 'ERRO: Token OpenCellID nao configurado.';
+        log(msg + ' Abortando.');
+        throw new Error(msg);
+    }
@@
-    if (!tableOk) {
-        log('ERRO FATAL: Tabela nao foi criada.');
-        db.close();
-        process.exit(1);
-    }
+    if (!tableOk) {
+        log('ERRO FATAL: Tabela nao foi criada.');
+        db.close();
+        throw new Error('Tabela nao foi criada.');
+    }
@@
-        log('✅ Importacao concluida com sucesso!');
-        db.close();
-        process.exit(0);
+        log('✅ Importacao concluida com sucesso!');
+        db.close();
+        return { success: true, imported: count };
@@
-        db.close();
-        process.exit(1);
+        db.close();
+        throw err;
     }
 }
-
-main();
+
+module.exports = { main };
+
+if (require.main === module) {
+    main()
+        .then(() => process.exit(0))
+        .catch((err) => {
+            console.error('[IMPORT] ERRO FATAL:', err && err.message ? err.message : err);
+            process.exit(1);
+        });
+}
*** End Patch