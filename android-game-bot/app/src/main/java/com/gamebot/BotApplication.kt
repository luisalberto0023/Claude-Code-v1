package com.gamebot

import android.app.Application
import android.util.Log

class BotApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Log.i("BotApplication", "GameBot started")
    }
}
