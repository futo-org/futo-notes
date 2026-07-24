package com.futo.notes.ui

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertEquals
import org.junit.Test

class EditorMutationGateTest {
    @Test
    fun `queued editor save is rejected after destructive action begins`() = runBlocking {
        val gate = EditorMutationGate()
        var wrote = false

        gate.beginDestructiveAction()
        val result = gate.runEditorMutation {
            wrote = true
            "written"
        }

        assertNull(result)
        assertFalse(wrote)
    }

    @Test
    fun `delete waits for in-flight editor workflow and remains the final mutation`() = runBlocking {
        val gate = EditorMutationGate()
        val editorStarted = CompletableDeferred<Unit>()
        val releaseEditor = CompletableDeferred<Unit>()
        val order = mutableListOf<String>()

        val editor = launch {
            gate.runEditorMutation {
                editorStarted.complete(Unit)
                releaseEditor.await()
                order += "editor"
            }
        }
        editorStarted.await()
        gate.beginDestructiveAction()
        val delete = launch {
            gate.runDestructiveMutation {
                order += "delete"
            }
        }
        releaseEditor.complete(Unit)
        editor.join()
        delete.join()

        assertEquals(listOf("editor", "delete"), order)
    }

    @Test
    fun `navigation waits for an in-flight image workflow`() = runBlocking {
        val gate = EditorMutationGate()
        val imageStarted = CompletableDeferred<Unit>()
        val releaseImage = CompletableDeferred<Unit>()
        val order = mutableListOf<String>()

        val image = launch {
            gate.runEditorMutation {
                imageStarted.complete(Unit)
                releaseImage.await()
                order += "image inserted"
            }
        }
        imageStarted.await()
        val navigation = launch {
            gate.runEditorMutation {
                order += "navigation saved"
            }
        }
        releaseImage.complete(Unit)
        image.join()
        navigation.join()

        assertEquals(listOf("image inserted", "navigation saved"), order)
    }
}
