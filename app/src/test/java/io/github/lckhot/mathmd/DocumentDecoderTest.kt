package io.github.lckhot.mathmd

import org.junit.Assert.assertEquals
import org.junit.Test

/** L3: BOM-aware decoding; no other encoding guessing. */
class DocumentDecoderTest {

    @Test
    fun utf8BomIsStrippedExactlyOnce() {
        val bytes = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) +
            "# 标题 \$x\$\n正文".toByteArray(Charsets.UTF_8)
        assertEquals("# 标题 \$x\$\n正文", DocumentDecoder.decode(bytes))
    }

    @Test
    fun doubleUtf8BomKeepsOneRemnant() {
        val bom = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
        val bytes = bom + bom + "text".toByteArray(Charsets.UTF_8)
        // Only the FIRST BOM is a signature; the second decodes as U+FEFF.
        assertEquals("﻿text", DocumentDecoder.decode(bytes))
    }

    @Test
    fun utf16LeBomDecodes() {
        val text = "# 中文 \$x_i\$ formula"
        val payload = text.toByteArray(Charsets.UTF_16LE)
        val bytes = byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + payload
        assertEquals(text, DocumentDecoder.decode(bytes))
    }

    @Test
    fun utf16BeBomDecodes() {
        val text = "数学 \\(E=mc^2\\) 文档"
        val payload = text.toByteArray(Charsets.UTF_16BE)
        val bytes = byteArrayOf(0xFE.toByte(), 0xFF.toByte()) + payload
        assertEquals(text, DocumentDecoder.decode(bytes))
    }

    @Test
    fun plainUtf8AndEmptyInputDecodeAsUtf8() {
        assertEquals("plain ascii + 中文 + \$x\$", DocumentDecoder.decode("plain ascii + 中文 + \$x\$".toByteArray(Charsets.UTF_8)))
        assertEquals("", DocumentDecoder.decode(ByteArray(0)))
    }

    @Test
    fun notABomWhenTooShort() {
        // A lone 0xEF byte is not a BOM; it must not crash or mis-slice, and
        // decodes per the platform's UTF-8 policy (replacement char).
        assertEquals("�", DocumentDecoder.decode(byteArrayOf(0xEF.toByte())))
        assertEquals("�", DocumentDecoder.decode(byteArrayOf(0xFF.toByte())))
    }
}
