package com.futo.notes.textfirst

/** Bounded latency samples; idle flushes include the tail of a typing burst. */
internal class KeyLatencyWindow(private val capacity: Int = 50) {
    private val samples = ArrayList<KeyTimings>(capacity)
    private val resumes = ArrayList<Long>(capacity)
    private var previousInput = 0L

    fun add(sample: KeyTimings): Summary? {
        samples.add(sample)
        resumes.add(if (previousInput == 0L || sample.input - previousInput > 1_000_000_000L) sample.drawEnd - sample.input else 0L)
        previousInput = sample.input
        return if (samples.size == capacity) flush() else null
    }

    fun flush(): Summary? {
        if (samples.isEmpty()) return null
        fun percentile(values: List<Long>, fraction: Int): Double =
            values.sorted()[((values.size * fraction) / 100).coerceAtMost(values.lastIndex)] / 1_000_000.0
        val response = samples.map { it.drawEnd - it.input }
        val summary = Summary(
            samples.size, percentile(response, 50), percentile(response, 95), response.max() / 1_000_000.0,
            percentile(samples.map { it.workNanos }, 95), resumes.max() / 1_000_000.0,
            samples.first().input, samples.last().input,
        )
        samples.clear()
        resumes.clear()
        return summary
    }

    data class Summary(
        val count: Int, val p50: Double, val p95: Double, val max: Double,
        val workP95: Double, val resumeMax: Double, val firstInputNs: Long, val lastInputNs: Long,
    ) {
        override fun toString(): String =
            "input→draw over $count: p50=${p50}ms p95=${p95}ms max=${max}ms " +
                "workP95=${workP95}ms resumeMax=${resumeMax}ms firstInputNs=$firstInputNs lastInputNs=$lastInputNs"
    }
}
