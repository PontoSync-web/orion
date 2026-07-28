package com.orion.agent

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var etServerUrl: EditText
    private lateinit var etPhoneNumber: EditText
    private lateinit var btnStart: Button
    private lateinit var btnStop: Button
    private lateinit var tvStatus: TextView

    companion object {
        const val REQUEST_PERMISSIONS = 100
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        etServerUrl = findViewById(R.id.etServerUrl)
        etPhoneNumber = findViewById(R.id.etPhoneNumber)
        btnStart = findViewById(R.id.btnStart)
        btnStop = findViewById(R.id.btnStop)
        tvStatus = findViewById(R.id.tvStatus)

        etServerUrl.setText("https://orion-29ko.onrender.com/api/localizar-por-cells")

        btnStart.setOnClickListener { startCollection() }
        btnStop.setOnClickListener { stopCollection() }

        requestPermissions()
    }

    private fun requestPermissions() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.READ_PHONE_STATE
                ),
                REQUEST_PERMISSIONS
            )
        }
    }

    private fun startCollection() {
        val serverUrl = etServerUrl.text.toString()
        val phoneNumber = etPhoneNumber.text.toString()

        if (serverUrl.isEmpty()) {
            Toast.makeText(this, "URL do servidor é obrigatória", Toast.LENGTH_SHORT).show()
            return
        }

        val intent = Intent(this, CellCollectorService::class.java)
        intent.putExtra("server_url", serverUrl)
        intent.putExtra("phone_number", phoneNumber)
        ContextCompat.startForegroundService(this, intent)
        tvStatus.text = "Serviço iniciado"
    }

    private fun stopCollection() {
        val intent = Intent(this, CellCollectorService::class.java)
        stopService(intent)
        tvStatus.text = "Serviço parado"
    }
}
