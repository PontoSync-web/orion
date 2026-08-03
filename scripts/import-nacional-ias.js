@@
-    db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
-        radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
-        cell INTEGER PRIMARY KEY, unit INTEGER,
-        lon REAL, lat REAL, range INTEGER,
-        samples INTEGER, changeable INTEGER,
-        created INTEGER, updated INTEGER, averageSignal INTEGER
-    )`);
+    db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
+        radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
+        cell INTEGER PRIMARY KEY, unit INTEGER,
+        lon REAL, lat REAL, range INTEGER,
+        samples INTEGER, changeable INTEGER,
+        created INTEGER, updated INTEGER, averageSignal INTEGER,
+        call_id TEXT
+    )`);
@@
-        const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
+        const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
@@
-            stmt.run([
-                'GSM',
-                erb.mcc || 724,
-                erb.mnc || 5,
-                erb.lac || Math.floor(Math.random() * 1000) + 100,
-                erb.cell_id,
-                0,
-                erb.lon,
-                erb.lat,
-                erb.range || 5000,
-                erb.samples || 100,
-                1,
-                1609459200,
-                1609459200,
-                erb.averageSignal || -71
-            ]);
+            const callId = erb.call_id || erb.callId || null;
+            const safeCallId = (typeof callId === 'string' && callId.length > 64) ? callId.substring(0,64) : callId;
+            stmt.run([
+                'GSM',
+                erb.mcc || 724,
+                erb.mnc || 5,
+                erb.lac || Math.floor(Math.random() * 1000) + 100,
+                erb.cell_id,
+                0,
+                erb.lon,
+                erb.lat,
+                erb.range || 5000,
+                erb.samples || 100,
+                1,
+                1609459200,
+                1609459200,
+                erb.averageSignal || -71,
+                safeCallId
+            ]);
*** End Patch
