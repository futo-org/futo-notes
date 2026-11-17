package com.futo.notes.textfirst

/** !300's names for common languages (src/features/editor/live-preview/widgets.ts `CODE_LANGUAGE_LABELS`). */
private val codeLanguageNames = mapOf(
    "javascript" to "JavaScript", "typescript" to "TypeScript", "tsx" to "TypeScript JSX", "jsx" to "JavaScript JSX",
    "python" to "Python", "ruby" to "Ruby", "rust" to "Rust", "go" to "Go", "java" to "Java", "kotlin" to "Kotlin",
    "swift" to "Swift", "c" to "C", "cpp" to "C++", "csharp" to "C#", "html" to "HTML", "css" to "CSS", "json" to "JSON",
    "yaml" to "YAML", "xml" to "XML", "sql" to "SQL", "bash" to "Bash", "sh" to "Bash", "zsh" to "Zsh", "shell" to "Shell",
    "md" to "Markdown", "markdown" to "Markdown",
)

/** How the header shows a fence's language: its known name, or the word with its first letter capitalised (`go` → `Go`, `cobolx` → `Cobolx`). */
internal fun codeLanguageLabel(language: String): String =
    codeLanguageNames[language.lowercase()] ?: language.replaceFirstChar { it.uppercaseChar() }
