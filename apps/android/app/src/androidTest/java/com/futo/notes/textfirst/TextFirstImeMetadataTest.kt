package com.futo.notes.textfirst

import android.os.LocaleList
import android.text.InputType
import android.view.inputmethod.EditorInfo
import androidx.test.platform.app.InstrumentationRegistry
import androidx.core.view.inputmethod.EditorInfoCompat
import org.junit.Assert.*
import org.junit.Test

class TextFirstImeMetadataTest {
    @Test fun manualInfoPreservesPublicMetadataWithoutCreatingANativeConnection() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val metrics = context.resources.displayMetrics
            val font = android.graphics.Typeface.DEFAULT
            val style = TextFirstStyle(metrics.density, 17f, font, font, font, font, 0, 0, 0, 0, 0, 0)
            val view = TextFirstEditText(context, style, ImageLoader(context, context.cacheDir))
            assertNull("pre-open focus cannot create TextView's native IME state", view.onCreateInputConnection(EditorInfo()))
            view.privateImeOptions = "test-options"
            view.imeHintLocales = LocaleList.forLanguageTags("en-US")
            view.hint = "context hint"
            view.setImeActionLabel("test action", 42)
            view.getInputExtras(true)!!.putString("metadata", "kept")
            val state = EngineImeState.capture("hello world", 6, 11, 6, 11, IME_CAPS_MODES)
            val info = EditorInfo()
            view.populateEngineEditorInfo(info, state, false)
            assertEquals("test-options", info.privateImeOptions)
            assertEquals("context hint", info.hintText.toString())
            assertEquals("test action", info.actionLabel.toString())
            assertEquals(42, info.actionId)
            assertEquals("kept", info.extras!!.getString("metadata"))
            assertEquals(view.imeHintLocales, info.hintLocales)
            assertEquals(6, info.initialSelStart)
            assertEquals(11, info.initialSelEnd)
            assertEquals("world", EditorInfoCompat.getInitialSelectedText(info, 0).toString())
            assertArrayEquals(arrayOf("image/*"), EditorInfoCompat.getContentMimeTypes(info))
            assertTrue(info.imeOptions and EditorInfo.IME_FLAG_NO_EXTRACT_UI != 0)
            assertTrue(info.imeOptions and EditorInfo.IME_FLAG_NO_ENTER_ACTION != 0)
            view.populateEngineEditorInfo(info, state, true)
            assertEquals(0, info.inputType and (InputType.TYPE_TEXT_FLAG_AUTO_CORRECT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES))
            assertTrue(info.inputType and InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS != 0)
            assertEquals(0, info.initialCapsMode)
        }
    }
}
