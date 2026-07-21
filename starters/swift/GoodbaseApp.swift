import Goodbase

let goodbase = GoodbaseClient()

func secureDevice(appId: String, assertion: [String: String]) async throws {
    _ = try await goodbase.exchangeAttestation(appId: appId, assertion: assertion)
}

