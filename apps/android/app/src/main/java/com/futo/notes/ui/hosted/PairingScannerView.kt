package com.futo.notes.ui.hosted

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.futo.notes.sync.hosted.decodePairingCode
import com.google.zxing.PlanarYUVLuminanceSource
import java.util.concurrent.Executors

/**
 * The camera, and nothing else. It reads QR codes and hands up the string
 * inside one — every decision about that string is made above it, which is what
 * lets the whole scan path be exercised without a camera (ADR 0003, decision
 * 12).
 *
 * CameraX rather than the platform camera API: the lifecycle binding, the
 * rotation handling, and the frame stream are the parts that are easy to get
 * wrong, and this is the maintained way to not write them.
 */
@Composable
fun PairingScannerView(modifier: Modifier = Modifier, onCode: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    // The callback may change identity across recompositions; the analyzer is
    // bound once, so it must read the current one rather than capture the first.
    val currentOnCode by rememberUpdatedState(onCode)

    val preview = remember(context) {
        PreviewView(context).apply {
            // The scanner lives in a dialog window, where the default
            // SurfaceView path can end up behind or clipped by that window's
            // own surface. A TextureView is an ordinary view in the hierarchy
            // and composites normally, at a cost nobody can see on a preview.
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
    }

    DisposableEffect(preview, lifecycleOwner) {
        // One thread, and analysis set to keep only the newest frame: decoding
        // is slower than the camera produces, and a backlog would read a code
        // the person has already moved away from.
        val frames = Executors.newSingleThreadExecutor()
        // A camera in front of one code reports it many times a second.
        // Reporting only a change means an unreadable code raises its message
        // once instead of on every frame.
        var lastReported: String? = null

        val providerFuture = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        providerFuture.addListener({
            val bound = providerFuture.get()
            provider = bound
            val previewUseCase = Preview.Builder().build()
            previewUseCase.setSurfaceProvider(preview.surfaceProvider)
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(frames) { frame ->
                val scanned = frame.use { luminance(it)?.let(::decodePairingCode) }
                if (scanned != null && scanned != lastReported) {
                    lastReported = scanned
                    ContextCompat.getMainExecutor(context).execute { currentOnCode(scanned) }
                }
            }
            bound.unbindAll()
            bound.bindToLifecycle(
                lifecycleOwner,
                CameraSelector.DEFAULT_BACK_CAMERA,
                previewUseCase,
                analysis,
            )
        }, ContextCompat.getMainExecutor(context))

        onDispose {
            provider?.unbindAll()
            frames.shutdown()
        }
    }

    AndroidView(factory = { preview }, modifier = modifier)
}

/**
 * The brightness plane of one camera frame, as ZXing reads a picture.
 *
 * CameraX hands over YUV, whose first plane IS the greyscale image — so no
 * colour conversion happens here at all. `rowStride` is the plane's real width
 * in bytes and is often larger than the image, which is exactly what
 * `PlanarYUVLuminanceSource`'s `dataWidth` is for.
 */
private fun luminance(frame: ImageProxy): PlanarYUVLuminanceSource? {
    val plane = frame.planes.firstOrNull() ?: return null
    val buffer = plane.buffer
    val bytes = ByteArray(buffer.remaining())
    buffer.get(bytes)
    return try {
        PlanarYUVLuminanceSource(
            bytes,
            plane.rowStride,
            frame.height,
            0,
            0,
            frame.width,
            frame.height,
            false,
        )
    } catch (_: IllegalArgumentException) {
        // A frame whose stride and height do not describe the buffer we were
        // given. Skipping it costs one frame out of thirty.
        null
    }
}
