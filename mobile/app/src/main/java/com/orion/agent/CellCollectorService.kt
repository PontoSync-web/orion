package com.orion.agent

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.telephony.CellInfo
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoWcdma
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

class CellCollectorService : Service() {

    private lateinit var telephonyManager: TelephonyManager
    private var serverUrl = "https://orion-29ko.onrender.com/api/localizar-por-cells"
    private var phoneNumber = ""
    private val handler = Handler(Looper.getMainLooper())
    private var isRunning = false

    override fun onCreate() {
        super.onCreate()
        telephonyManager = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.getStringExtra("server_url")?.let { serverUrl = it }
        intent?.getStringExtra("phone_number")?.let { phoneNumber = it }
        startForegroundNotification()
        startCollecting()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startForegroundNotification() {
        val channelId = "orion_agent"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(channelId, "ORION Agent", NotificationManager.IMPORTANCE_LOW)
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }

        val pendingIntent = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)

        val notification = NotificationCompat.Builder(this, channelId)
            .setContentTitle("ORION Agent")
            .setContentText("Coletando torres de celular...")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        startForeground(1, notification)
    }

    private fun startCollecting() {
        isRunning = true
        val runnable = object : Runnable {
            override fun run() {
                if (isRunning) {
                    collectAndSend()
                    handler.postDelayed(this, 15_000)
                }
            }
        }
        handler.post(runnable)
    }

    private fun collectAndSend() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            Log.w("ORION", "Sem permissão de localização")
            return
        }

        val cells = JSONArray()
        val allCellInfo = telephonyManager.allCellInfo

        for (info in allCellInfo) {
            val cell = JSONObject()
            when (info) {
                is CellInfoGsm -> {
                    cell.put("cellId", info.cellIdentity.cid)
                    cell.put("rssi", info.cellSignalStrength.dbm)
                    cell.put("lac", info.cellIdentity.lac)
                    cell.put("mcc", info.cellIdentity.mcc)
                    cell.put("mnc", info.cellIdentity.mnc)
                }
                is CellInfoLte -> {
                    cell.put("cellId", info.cellIdentity.ci)
                    cell.put("rssi", info.cellSignalStrength.dbm)
                    cell.put("lac", info.cellIdentity.tac)
                    cell.put("mcc", info.cellIdentity.mcc)
                    cell.put("mnc", info.cellIdentity.mnc)
                }
                is CellInfoWcdma -> {
                    cell.put("cellId", info.cellIdentity.cid)
                    cell.put("rssi", info.cellSignalStrength.dbm)
                    cell.put("lac", info.cellIdentity.lac)
                    cell.put("mcc", info.cellIdentity.mcc)
                    cell.put("mnc", info.cellIdentity.mnc)
                }
            }
            if (cell.has("cellId")) cells.put(cell)
        }

        if (cells.length() == 0) return

        val json = JSONObject()
        json.put("numero", phoneNumber)
        json.put("cells", cells)

        try {
            val url = URL(serverUrl)
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            val output: OutputStream = conn.outputStream
            output.write(json.toString().toByteArray())
            output.close()
            val code = conn.responseCode
            Log.i("ORION", "Enviado $cellsLength células – resposta $code".replace("$cellsLength", cells.length().toString()))
            conn.disconnect()
        } catch (e: Exception) {
            Log.e("ORION", "Erro ao enviar dados: ${e.message}")
        }
    }

    override fun onDestroy() {
        isRunning = false
        super.onDestroy()
    }
}
