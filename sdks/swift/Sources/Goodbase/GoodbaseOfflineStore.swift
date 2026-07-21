import CryptoKit
import Foundation

public protocol GoodbaseOfflineCipher: Sendable {
    func seal(_ plaintext: Data) throws -> Data
    func open(_ ciphertext: Data) throws -> Data
}

public struct GoodbaseAESGCMCipher: GoodbaseOfflineCipher {
    private let key: SymmetricKey
    public init(keyData: Data) { self.key = SymmetricKey(data: keyData) }
    public func seal(_ plaintext: Data) throws -> Data { try AES.GCM.seal(plaintext, using: key).combined! }
    public func open(_ ciphertext: Data) throws -> Data { try AES.GCM.open(AES.GCM.SealedBox(combined: ciphertext), using: key) }
}

public struct GoodbaseOfflineMutation: Codable, Sendable {
    public let idempotencyKey: String
    public let collection: String
    public let recordKey: String
    public let operation: String
    public let expectedVersion: Int?
    public let payload: Data?
    public let createdAt: Date
}

private struct GoodbaseOfflineEnvelope: Codable {
    var schemaVersion: Int
    var userHash: String
    var cursor: Int64
    var mutations: [GoodbaseOfflineMutation]
}

public actor GoodbaseOfflineStore {
    private let fileURL: URL
    private let cipher: any GoodbaseOfflineCipher
    private var envelope: GoodbaseOfflineEnvelope

    public init(rootDirectory: URL, userID: String, cipher: any GoodbaseOfflineCipher, schemaVersion: Int = 1) throws {
        let digest = SHA256.hash(data: Data(userID.utf8)).map { String(format: "%02x", $0) }.joined()
        let directory = rootDirectory.appendingPathComponent("GoodbaseOffline", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        let storeFile = directory.appendingPathComponent("\(digest).store")
        self.fileURL = storeFile
        self.cipher = cipher
        if FileManager.default.fileExists(atPath: storeFile.path) {
            let decoded = try JSONDecoder().decode(GoodbaseOfflineEnvelope.self, from: cipher.open(Data(contentsOf: storeFile)))
            guard decoded.userHash == digest, decoded.schemaVersion <= schemaVersion else { throw CocoaError(.fileReadCorruptFile) }
            self.envelope = GoodbaseOfflineEnvelope(schemaVersion: schemaVersion, userHash: digest, cursor: decoded.cursor, mutations: decoded.mutations)
        } else {
            self.envelope = GoodbaseOfflineEnvelope(schemaVersion: schemaVersion, userHash: digest, cursor: 0, mutations: [])
        }
    }

    public func queue(collection: String, recordKey: String, operation: String = "upsert", expectedVersion: Int? = nil, payload: Data? = nil, idempotencyKey: String = UUID().uuidString) throws -> GoodbaseOfflineMutation {
        if let existing = envelope.mutations.first(where: { $0.idempotencyKey == idempotencyKey }) { return existing }
        let mutation = GoodbaseOfflineMutation(idempotencyKey: idempotencyKey, collection: collection, recordKey: recordKey, operation: operation == "delete" ? "delete" : "upsert", expectedVersion: expectedVersion, payload: payload, createdAt: Date())
        envelope.mutations.append(mutation); try persist(); return mutation
    }
    public func pending(limit: Int = 100) -> [GoodbaseOfflineMutation] { Array(envelope.mutations.prefix(max(1, min(limit, 1000)))) }
    public func acknowledge(idempotencyKeys: Set<String>, cursor: Int64) throws { envelope.mutations.removeAll { idempotencyKeys.contains($0.idempotencyKey) }; envelope.cursor = max(envelope.cursor, cursor); try persist() }
    public func currentCursor() -> Int64 { envelope.cursor }
    public func clearForLogout() throws { envelope.mutations.removeAll(); envelope.cursor = 0; if FileManager.default.fileExists(atPath: fileURL.path) { try FileManager.default.removeItem(at: fileURL) } }
    private func persist() throws { let encrypted = try cipher.seal(JSONEncoder().encode(envelope)); try encrypted.write(to: fileURL, options: .atomic); try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: fileURL.path) }
}
