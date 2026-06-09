package com.futo.notes.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.unit.dp
import com.futo.notes.NotesStore
import com.futo.notes.ui.components.MicroLabel
import com.futo.notes.ui.components.NoteCard
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoType
import com.futo.notes.ui.theme.FutoTheme

/**
 * Search over the real note set (FFI). Filtering is a case-insensitive
 * substring match on title/preview/tags — NOTE: not the ranked BM25 engine
 * (`futo-notes-index`), which is not exposed via FFI. The mock "Ask your notes"
 * answer card from the design is intentionally omitted (no semantic engine on
 * native).
 */
@Composable
fun SearchScreen(
    store: NotesStore,
    onOpenNote: (String) -> Unit,
    onBack: () -> Unit,
) {
    val c = FutoTheme.colors
    var query by remember { mutableStateOf("") }
    val q = query.trim().lowercase()

    val results = if (q.isBlank()) emptyList() else store.notes.filter {
        it.title.lowercase().contains(q) ||
            it.preview.lowercase().contains(q) ||
            it.tags.any { t -> t.lowercase().contains(q) }
    }
    val recent = store.notes.take(8)

    Column(modifier = Modifier.fillMaxWidth().statusBarsPadding()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp),
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = c.textSecondary)
            }
            Surface(
                color = c.surfaceSunken,
                shape = RoundedCornerShape(FutoRadius.pill),
                modifier = Modifier.weight(1f),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    Icon(Icons.Filled.Search, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(10.dp))
                    Box(Modifier.weight(1f)) {
                        if (query.isEmpty()) {
                            Text("Search your notes", style = FutoType.body, color = c.textMuted)
                        }
                        BasicTextField(
                            value = query,
                            onValueChange = { query = it },
                            singleLine = true,
                            textStyle = FutoType.body.copy(color = c.textPrimary),
                            cursorBrush = SolidColor(c.accent),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    if (query.isNotEmpty()) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = "Clear",
                            tint = c.textMuted,
                            modifier = Modifier.size(18.dp).clickable { query = "" },
                        )
                    }
                }
            }
            Spacer(Modifier.width(6.dp))
        }

        LazyColumn(
            contentPadding = PaddingValues(16.dp, 6.dp, 16.dp, 32.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (q.isBlank()) {
                if (recent.isNotEmpty()) {
                    item { MicroLabel("Recent", Modifier.padding(start = 4.dp, top = 4.dp)) }
                    items(recent, key = { it.id }) { NoteCard(it, onClick = { onOpenNote(it.id) }) }
                }
            } else {
                item {
                    MicroLabel(
                        if (results.isEmpty()) "No matches" else "${results.size} results",
                        Modifier.padding(start = 4.dp, top = 4.dp),
                    )
                }
                items(results, key = { it.id }) { NoteCard(it, showFolder = true, onClick = { onOpenNote(it.id) }) }
            }
        }
    }
}
