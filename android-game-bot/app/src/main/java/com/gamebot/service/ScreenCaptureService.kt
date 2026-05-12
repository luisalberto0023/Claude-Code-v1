package com.gamebot.service

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/**
 * Captures the device screen using the MediaProjection API.
 *
 * This replaces `adb exec-out screencap -p` from the desktop-Python version.
 * The user grants permission ONCE via the system screen-recording dialog
 * (Android shows "GameBot will start capturing everything displayed on your screen").
 * The resulting MediaProjection token is kept alive inside BotForegroundService.
 *
 * Call [start] with the token, then [captureBase64] whenever a screenshot is needed.
 */
class ScreenCaptureService(private val context: Context) {

    private var mediaProjection: MediaProjection? = null
    private var imageReader: ImageReader?          = null
    private var virtualDisplay: VirtualDisplay?    = null

    var screenWidth  = 0; private set
    var screenHeight = 0; private set
    private var density = 0

    val isReady: Boolean get() = virtualDisplay != null

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    fun start(resultCode: Int, data: android.content.Intent) {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)
        screenWidth  = metrics.widthPixels
        screenHeight = metrics.heightPixels
        density      = metrics.densityDpi

        imageReader = ImageReader.newInstance(
            screenWidth, screenHeight,
            PixelFormat.RGBA_8888,
            2,  // maxImages: keep last 2 frames
        )

        val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
            as MediaProjectionManager
        mediaProjection = manager.getMediaProjection(resultCode, data)

        virtualDisplay = mediaProjection?.createVirtualDisplay(
            "GameBotCapture",
            screenWidth, screenHeight, density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader!!.surface,
            null, null,
        )
    }

    fun stop() {
        virtualDisplay?.release()
        imageReader?.close()
        mediaProjection?.stop()
        virtualDisplay    = null
        imageReader       = null
        mediaProjection   = null
    }

    // ── Capture ───────────────────────────────────────────────────────────────

    /**
     * Acquire the latest frame and return it as a base64-encoded PNG string
     * suitable for sending to the Claude Vision API.
     *
     * Returns null if no frame is available yet.
     */
    suspend fun captureBase64(): String? = withContext(Dispatchers.IO) {
        val reader = imageReader ?: return@withContext null

        // Wait up to 500 ms for a frame
        var image = reader.acquireLatestImage()
        var waited = 0
        while (image == null && waited < 500) {
            delay(50)
            waited += 50
            image = reader.acquireLatestImage()
        }
        image ?: return@withContext null

        try {
            val planes     = image.planes
            val buffer     = planes[0].buffer
            val pixelStride = planes[0].pixelStride
            val rowStride   = planes[0].rowStride
            val rowPadding  = rowStride - pixelStride * image.width

            val rawBitmap = Bitmap.createBitmap(
                image.width + rowPadding / pixelStride,
                image.height,
                Bitmap.Config.ARGB_8888,
            )
            rawBitmap.copyPixelsFromBuffer(buffer)

            // Crop away row-padding artefact
            val bitmap = Bitmap.createBitmap(rawBitmap, 0, 0, image.width, image.height)
            rawBitmap.recycle()

            // Encode to PNG bytes then base64
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            bitmap.recycle()

            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } finally {
            image.close()
        }
    }

    /** Convenience: capture and return as a Bitmap (for local display). */
    suspend fun captureBitmap(): Bitmap? = withContext(Dispatchers.IO) {
        val reader = imageReader ?: return@withContext null
        val image  = reader.acquireLatestImage() ?: return@withContext null
        try {
            val planes      = image.planes
            val buffer      = planes[0].buffer
            val pixelStride = planes[0].pixelStride
            val rowStride   = planes[0].rowStride
            val rowPadding  = rowStride - pixelStride * image.width

            val bmp = Bitmap.createBitmap(
                image.width + rowPadding / pixelStride,
                image.height,
                Bitmap.Config.ARGB_8888,
            )
            bmp.copyPixelsFromBuffer(buffer)
            Bitmap.createBitmap(bmp, 0, 0, image.width, image.height)
                .also { bmp.recycle() }
        } finally {
            image.close()
        }
    }
}
