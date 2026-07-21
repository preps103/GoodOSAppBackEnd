package app.goodos.goodbase

import java.io.DataInputStream
import java.io.DataOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

interface GoodbaseOfflineCipher { fun seal(plaintext: ByteArray): ByteArray; fun open(ciphertext: ByteArray): ByteArray }
data class GoodbaseOfflineMutation(val idempotencyKey: String, val collection: String, val recordKey: String, val operation: String, val expectedVersion: Long?, val payload: ByteArray?, val createdAt: Long)

class GoodbaseOfflineStore(rootDirectory: Path, userId: String, private val cipher: GoodbaseOfflineCipher, private val schemaVersion: Int = 1) {
    private val file: Path
    private var cursor = 0L
    private val mutations = mutableListOf<GoodbaseOfflineMutation>()
    init {
        val userHash = MessageDigest.getInstance("SHA-256").digest(userId.toByteArray()).joinToString("") { "%02x".format(it) }
        val directory = rootDirectory.resolve("goodbase-offline"); Files.createDirectories(directory); file = directory.resolve("$userHash.store")
        if (Files.exists(file)) decode(cipher.open(Files.readAllBytes(file)), userHash) else persist(userHash)
    }
    @Synchronized fun queue(collection: String, recordKey: String, operation: String = "upsert", expectedVersion: Long? = null, payload: ByteArray? = null, idempotencyKey: String = UUID.randomUUID().toString()): GoodbaseOfflineMutation {
        mutations.firstOrNull { it.idempotencyKey == idempotencyKey }?.let { return it }
        val item = GoodbaseOfflineMutation(idempotencyKey, collection, recordKey, if (operation == "delete") "delete" else "upsert", expectedVersion, payload, Instant.now().toEpochMilli()); mutations.add(item); persist(); return item
    }
    @Synchronized fun pending(limit: Int = 100): List<GoodbaseOfflineMutation> = mutations.take(limit.coerceIn(1, 1000)).map { it.copy(payload = it.payload?.clone()) }
    @Synchronized fun acknowledge(keys: Set<String>, nextCursor: Long) { mutations.removeAll { keys.contains(it.idempotencyKey) }; cursor = maxOf(cursor, nextCursor); persist() }
    @Synchronized fun currentCursor(): Long = cursor
    @Synchronized fun clearForLogout() { mutations.clear(); cursor = 0; Files.deleteIfExists(file) }
    private var userHash = ""
    private fun persist(hash: String = userHash) { if (hash.isNotEmpty()) userHash = hash; val temporary = file.resolveSibling(file.fileName.toString() + ".tmp"); Files.write(temporary, cipher.seal(encode())); Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE) }
    private fun encode(): ByteArray { val buffer = java.io.ByteArrayOutputStream(); DataOutputStream(buffer).use { out -> out.writeInt(schemaVersion); out.writeUTF(userHash); out.writeLong(cursor); out.writeInt(mutations.size); mutations.forEach { item -> out.writeUTF(item.idempotencyKey); out.writeUTF(item.collection); out.writeUTF(item.recordKey); out.writeUTF(item.operation); out.writeBoolean(item.expectedVersion != null); item.expectedVersion?.let(out::writeLong); out.writeBoolean(item.payload != null); item.payload?.let { out.writeInt(it.size); out.write(it) }; out.writeLong(item.createdAt) } }; return buffer.toByteArray() }
    private fun decode(bytes: ByteArray, expectedHash: String) { DataInputStream(bytes.inputStream()).use { input -> val storedVersion = input.readInt(); require(storedVersion <= schemaVersion); userHash = input.readUTF(); require(userHash == expectedHash); cursor = input.readLong(); repeat(input.readInt().coerceIn(0, 100000)) { val id = input.readUTF(); val collection = input.readUTF(); val record = input.readUTF(); val operation = input.readUTF(); val version = if (input.readBoolean()) input.readLong() else null; val payload = if (input.readBoolean()) ByteArray(input.readInt().coerceIn(0, 16 * 1024 * 1024)).also(input::readFully) else null; mutations.add(GoodbaseOfflineMutation(id, collection, record, operation, version, payload, input.readLong())) } } }
}
