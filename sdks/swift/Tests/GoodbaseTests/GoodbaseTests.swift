import XCTest
@testable import Goodbase

final class GoodbaseTests: XCTestCase {
    func testTelemetryRequiresReleaseIdentity() {
        let configuration = GoodbaseTelemetry.Configuration(appID: "goodos", release: "1.0.0", buildNumber: "1")
        XCTAssertEqual(configuration.appID, "goodos")
        XCTAssertEqual(configuration.release, "1.0.0")
    }
}
