package org.futo.notes

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
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
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
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
    val notes = remember { mutableStateListOf<String>() }

    Column(Modifier.padding(16.dp)) {
        Row {
            TextField(
                value = text,
                onValueChange = { text = it},
                modifier = Modifier.weight(1f)
            )
            Button(
                onClick = {
                    if (text.isNotBlank()) {
                        notes.add(text)
                        text = ""
                    }
                },
                modifier = Modifier.padding(start = 8.dp)
            ) {
                Text ("Add")
            }
        }
        Spacer(Modifier.height(16.dp))

        LazyColumn {
            items(notes) { note ->
                Text(note, Modifier.padding(vertical = 4.dp))
            }
        }
    }
}