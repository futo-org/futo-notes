package com.futo.notes.textfirst

/** Stable, shareable performance inputs; no personal note or external corpus is needed. */
internal object TextFirstSyntheticNotes {
    val mixed: String get() = buildString {
        repeat(2_000) { row ->
            append("## Heading $row\n\n")
            append("paragraph **bold** *italic* ~~strike~~ $row\n\n")
            append("- list $row\n- second $row\n\n")
            append("> quote $row\n> continued $row\n\n")
        }
        append("```kotlin\nval literal = 1\n```\n\n")
        append("| column | value |\n| --- | --- |\n| item | text |\n")
    }
    val quote: String get() = buildString {
        repeat(2_000) { append("> quoted line $it with **bold** and ordinary text\n") }
    }
    val all: List<Pair<String, String>> get() = listOf("synthetic-mixed-20k" to mixed, "synthetic-quote-2k" to quote)
}
