package io.github.lckhot.mathmd

/**
 * BOM-aware document decoding (L3).
 *
 * Only the three byte-order marks are honored — UTF-8 (EF BB BF, stripped
 * once), UTF-16LE (FF FE) and UTF-16BE (FE FF). Everything else decodes as
 * UTF-8. No heuristic encoding detection: a misdetected charset silently
 * destroys a document, a fallback to UTF-8 matches every file this app's
 * own save path produces.
 */
internal object DocumentDecoder {

    fun decode(bytes: ByteArray): String = when {
        bytes.size >= 3 &&
            bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte() ->
            String(bytes, 3, bytes.size - 3, Charsets.UTF_8)
        bytes.size >= 2 &&
            bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte() ->
            String(bytes, 2, bytes.size - 2, Charsets.UTF_16LE)
        bytes.size >= 2 &&
            bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte() ->
            String(bytes, 2, bytes.size - 2, Charsets.UTF_16BE)
        else -> String(bytes, Charsets.UTF_8)
    }
}
