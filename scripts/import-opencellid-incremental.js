@@
-    db.run(`CREATE TABLE IF NOT EXISTS cell_towers (radio TEXT, mcc INTEGER, net INTEGER, area INTEGER, cell INTEGER PRIMARY KEY, unit INTEGER, lon REAL, lat REAL, range INTEGER, samples INTEGER, changeable INTEGER, created INTEGER, updated INTEGER, averageSignal INTEGER)`);
+    db.run(`CREATE TABLE IF NOT EXISTS cell_towers (radio TEXT, mcc INTEGER, net INTEGER, area INTEGER, cell INTEGER PRIMARY KEY, unit INTEGER, lon REAL, lat REAL, range INTEGER, samples INTEGER, changeable INTEGER, created INTEGER, updated INTEGER, averageSignal INTEGER, call_id TEXT)`);
@@
-        const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
-        const count = await importarCSV(db, csvPath, stmt);
+        const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
+        const count = await importarCSV(db, csvPath, stmt);
@@
-                stmt.run([
-                    cols[0], parseInt(cols[1]), parseInt(cols[2]), parseInt(cols[3]),
-                    parseInt(cols[4]), parseInt(cols[5]), parseFloat(cols[6]), parseFloat(cols[7]),
-                    parseInt(cols[8]), parseInt(cols[9]), parseInt(cols[10]), parseInt(cols[11]),
-                    parseInt(cols[12]), parseInt(cols[13])
-                ]);
+                stmt.run([
+                    cols[0], parseInt(cols[1]), parseInt(cols[2]), parseInt(cols[3]),
+                    parseInt(cols[4]), parseInt(cols[5]), parseFloat(cols[6]), parseFloat(cols[7]),
+                    parseInt(cols[8]), parseInt(cols[9]), parseInt(cols[10]), parseInt(cols[11]),
+                    parseInt(cols[12]), parseInt(cols[13]), null
+                ]);
*** End Patch
