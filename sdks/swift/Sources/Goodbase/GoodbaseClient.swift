import Foundation

public actor GoodbaseClient {
    public var accessToken: String?
    public var attestationToken: String?
    private let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL = URL(string: "https://base.goodos.app")!, accessToken: String? = nil, attestationToken: String? = nil, session: URLSession = .shared) {
        self.baseURL = baseURL; self.accessToken = accessToken; self.attestationToken = attestationToken; self.session = session
    }

    public func request<T: Decodable, Body: Encodable>(_ path: String, method: String = "GET", body: Body? = nil) async throws -> T {
        var request = URLRequest(url: URL(string: path, relativeTo: baseURL)!)
        request.httpMethod = method; request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "X-Request-ID")
        if let token = accessToken { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let token = attestationToken { request.setValue(token, forHTTPHeaderField: "X-Goodbase-Attestation") }
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    public struct AttestationChallenge: Codable { public let challengeId: String; public let nonce: String }
    public struct AttestationExchange: Codable { public let attestationToken: String; public let expiresIn: Int }
    private struct ChallengeRequest: Codable { let appId: String; let platform: String }
    private struct ExchangeRequest: Codable { let challengeId: String; let nonce: String; let assertion: [String:String] }
    public struct ProductResponse: Codable { public let success: Bool }
    private struct AnalyticsRequest: Codable { let appId: String; let events: [[String:String]]; let consentState: String }
    public struct CrashRequest: Codable { public let appId: String; public let platform: String; public let occurredAt: String; public let title: String; public let stackTrace: String? }
    public struct TraceRequest: Codable { public let appId: String; public let type: String; public let name: String; public let durationMs: Double; public let occurredAt: String }

    public func exchangeAttestation(appId: String, assertion: [String:String]) async throws -> AttestationExchange {
        let challenge: AttestationChallenge = try await request("/api/goodbase/v1/growth/attestation/challenge", method: "POST", body: ChallengeRequest(appId: appId, platform: "ios"))
        let exchange: AttestationExchange = try await request("/api/goodbase/v1/growth/attestation/exchange", method: "POST", body: ExchangeRequest(challengeId: challenge.challengeId, nonce: challenge.nonce, assertion: assertion))
        attestationToken = exchange.attestationToken
        return exchange
    }

    public func track(appId: String, events: [[String:String]], consentState: String) async throws -> ProductResponse {
        try await request("/api/goodbase/v1/product/analytics/events", method: "POST", body: AnalyticsRequest(appId: appId, events: events, consentState: consentState))
    }

    public func captureCrash(_ crash: CrashRequest) async throws -> ProductResponse {
        try await request("/api/goodbase/v1/product/telemetry/crashes", method: "POST", body: crash)
    }

    public func recordTrace(_ trace: TraceRequest) async throws -> ProductResponse {
        try await request("/api/goodbase/v1/product/telemetry/traces", method: "POST", body: trace)
    }

    public func remoteConfig<T: Decodable>(appId: String, responseType: T.Type) async throws -> T {
        try await request("/api/goodbase/v1/product/config/\(appId)", body: Optional<String>.none)
    }
}
