package io.github.lckhot.mathmd

/**
 * Durable record of an in-flight CreateDocument flow (P0 round, v2).
 *
 * When the Activity is recreated while a Create (Save As) write is in
 * flight, the UI callback lands in a dead closure and can no longer apply
 * rebind/savedText/follow-up — and the NEW composition has no operation
 * owner for the write, so its outcome is UNKNOWN (the executor task may or
 * may not have run). The record survives in rememberSaveable only so a new
 * composition can surface that fact ONCE and clear it; it deliberately
 * does NOT drive a rebind or a re-armed guard (the old behavior claimed an
 * exactly-once recovery the process model cannot guarantee).
 *
 * v2 format (newline-separated, backslash-escaped fields):
 *
 *   2 \n operationId \n uri \n followUpOrdinal | -
 *
 *  - [operationId] is the DocumentRequestGate ticket generation at accept
 *    time. A late live callback may clear the record ONLY when it still
 *    names that operation (a callback for create A must never clear the
 *    record of a newer create B).
 *  - [uri]/[followUp] are escaped so separators inside a field cannot
 *    shift the frame; decoding is defensive and returns null for anything
 *    malformed (including v1 records).
 */
internal object CreateFlow {

    const val VERSION = 2

    data class Record(
        val version: Int,
        val operationId: Long,
        val uri: String,
        val followUp: GuardAction?,
    )

    private fun esc(s: String): String =
        s.replace("\\", "\\\\").replace("\n", "\\n")

    /**
     * Single-pass decoder (a chained-replace pair cannot round-trip: it
     * would turn a literal backslash followed by 'n' into a newline).
     * `\\` → backslash, `\n` → newline, any other backslash stands for
     * itself (including a trailing one).
     */
    private fun unesc(s: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '\\' && i + 1 < s.length) {
                when (s[i + 1]) {
                    '\\' -> { sb.append('\\'); i += 2 }
                    'n' -> { sb.append('\n'); i += 2 }
                    else -> { sb.append(c); i += 1 }
                }
            } else {
                sb.append(c)
                i += 1
            }
        }
        return sb.toString()
    }

    fun encode(operationId: Long, uri: String, followUp: GuardAction?): String =
        listOf(
            VERSION.toString(),
            operationId.toString(),
            esc(uri),
            followUp?.ordinal?.toString() ?: "-",
        ).joinToString("\n")

    /** Decodes a v2 record; null for malformed input of any kind (defensive). */
    fun decode(record: String): Record? {
        val parts = record.split('\n', limit = 4)
        if (parts.size != 4) return null
        if (parts[0] != VERSION.toString()) return null
        val opId = parts[1].toLongOrNull() ?: return null
        if (opId < 0) return null
        val uri = unesc(parts[2])
        if (uri.isEmpty()) return null
        val followUp = when (val tag = parts[3]) {
            "-" -> null
            else -> tag.toIntOrNull()?.let { GuardAction.entries.getOrNull(it) } ?: return null
        }
        return Record(VERSION, opId, uri, followUp)
    }

    /**
     * True when [record] still names [operationId] — the only condition
     * under which that operation's callback may clear the record.
     */
    fun owns(record: String?, operationId: Long): Boolean {
        if (record == null) return false
        val decoded = decode(record) ?: return false
        return decoded.operationId == operationId
    }
}
