package com.futo.notes.puppet

import java.io.InputStream

/** One request this listener knows how to answer. */
internal sealed interface PuppetRoute {
    data object Actions : PuppetRoute

    data object Tree : PuppetRoute

    data class Verb(val name: String) : PuppetRoute

    data class Query(val command: String) : PuppetRoute
}

internal data class PuppetReply(val status: Int, val body: String)

internal class PuppetHttpRequest(val method: String, val path: String, val body: String) {
    companion object {
        private val HEADER_END = "\r\n\r\n".toByteArray()

        /** Read one request; null when the peer hangs up or overruns the ceiling. */
        fun read(stream: InputStream): PuppetHttpRequest? {
            val raw = ArrayList<Byte>()
            var headerEnd = -1
            while (headerEnd < 0) {
                val next = stream.read()
                if (next < 0 || raw.size > PuppetContract.MAX_REQUEST_BYTES) return null
                raw.add(next.toByte())
                if (raw.size >= HEADER_END.size &&
                    HEADER_END.indices.all { raw[raw.size - HEADER_END.size + it] == HEADER_END[it] }
                ) {
                    headerEnd = raw.size
                }
            }
            val header = String(raw.toByteArray(), Charsets.UTF_8)
            val lines = header.split("\r\n")
            val requestLine = lines.firstOrNull()?.split(" ") ?: return null
            if (requestLine.size < 2) return null
            val field = "content-length:"
            val contentLength = lines
                .firstOrNull { it.lowercase().startsWith(field) }
                ?.substring(field.length)?.trim()?.toIntOrNull() ?: 0
            if (contentLength > PuppetContract.MAX_REQUEST_BYTES) return null
            val body = ByteArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val got = stream.read(body, read, contentLength - read)
                if (got < 0) return null
                read += got
            }
            return PuppetHttpRequest(requestLine[0], requestLine[1], String(body, Charsets.UTF_8))
        }
    }
}
