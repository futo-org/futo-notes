package com.futo.notes.textfirst

import android.os.Bundle
import java.io.File

/**
 * Shared opt-in arguments: `textFirstBenchFixture` is an absolute device file,
 * `textFirstBenchOffset` a display UTF-16 position, and `textFirstBenchTimeoutSeconds`
 * bounds each wait. Reports use a neutral label and metrics, never the fixture path/content.
 * Action filters are comma-separated: `textFirstBenchActions` (type/enter/backspace)
 * or `textFirstCommandBenchActions` (select-all/all-<toolbar-id>/middle-list-toggle/quote-type).
 */
internal class TextFirstBenchmarkOptions(private val args: Bundle) {
    val externalSource: String? = args.getString("textFirstBenchFixture")?.let { path ->
        val file = File(path)
        check(file.isAbsolute && file.isFile && file.canRead()) { "External benchmark fixture is unavailable" }
        file.readText()
    }
    val fullyShown = args.getString("textFirstCommandBenchFullyShown")?.toBooleanStrict() ?: true
    val offset: Int? = args.getString("textFirstBenchOffset")?.toInt()?.also {
        require(it >= 0) { "Benchmark display offset must be nonnegative" }
    }
    val timeoutSeconds: Long = (args.getString("textFirstBenchTimeoutSeconds")?.toLong() ?: 120L).also {
        require(it in 1..600) { "Benchmark timeout must be between 1 and 600 seconds" }
    }

    fun actions(key: String, allowed: Set<String>): Set<String> {
        val selected = args.getString(key)?.split(',')?.map { it.trim() }?.toSet() ?: allowed
        require(selected.isNotEmpty() && selected.all { it in allowed }) { "Unknown or empty benchmark action filter" }
        return selected
    }
}
