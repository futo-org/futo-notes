package org.futo.notes.core

import java.util.UUID

data class Note (
    val id: String = UUID.randomUUID().toString(),
    val title: String,
    val body: String = "",
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis(),
    val isDeleted: Boolean = false
)