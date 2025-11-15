package org.futo.notes

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.modifier.modifierLocalConsumer
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.selects.select
import org.futo.notes.core.Note
import org.futo.notes.ui.theme.FUTONotesTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            FUTONotesTheme {
                NotesApp()
            }
        }
    }
}

@Composable
fun NotesApp() {
    var text by remember { mutableStateOf("") }
    val notes = remember { mutableStateListOf<Note>() }
    var selectedNote by remember {mutableStateOf<Note?>(null)}

    if (selectedNote === null) {
        NotesList(text, notes, onTextChange = {text = it}, onAddNote = {
            if (text.isNotBlank()) {
                notes.add(Note(title=text))
                text = ""
            }
        }, onNoteClick = {note ->
            selectedNote = note})
    } else {
        NotesDetailScreen(selectedNote!!, onBack = {selectedNote= null})
    }




}

@Composable
fun NotesList(text: String, notes: List<Note>, onTextChange: (String) -> Unit, onAddNote: () -> Unit, onNoteClick: (Note) -> Unit) {
    Column(Modifier.padding(16.dp)) {
        Row {
            TextField(
                value = text,
                onValueChange = onTextChange,
                modifier = Modifier.weight(1f)
            )
            Button(
                onClick = onAddNote , modifier = Modifier.padding(start = 8.dp)
            ) {
                Text ("Add")
            }
        }
        Spacer(Modifier.height(16.dp))

        LazyColumn {
            items(notes) { note ->
                Text(note.title, Modifier
                    .padding(vertical = 4.dp)
                    .clickable { onNoteClick(note) })
            }
        }
    }

}

@Composable
fun NotesDetailScreen(note: Note, onBack: () -> Unit) {
    Column(modifier = Modifier.fillMaxSize()) {
        Button(onClick = onBack) {
            Text("Back")
        }
        Spacer(Modifier.height(16.dp))

        Text(text = note.title)
        Text(text = note.body)
    }
}