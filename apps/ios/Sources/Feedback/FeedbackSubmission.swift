import Foundation
import UIKit

enum FeedbackSubmission {
    static let maxMessageLength = 10_000

    private static var feedbackApiUrl: URL { CrashlogEndpoint.url("/api/feedback") }

    struct Failed: LocalizedError {
        let status: Int?
        var errorDescription: String? {
            guard let status else { return "Could not reach the server." }
            return "The server refused it (HTTP \(status))."
        }
    }

    static func body(message: String, images: [Data]) -> [String: Any] {
        [
            "message": message,
            "app_version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
                as? String ?? "0.0.0",
            "platform": "ios",
            "os_version": "iOS \(UIDevice.current.systemVersion)",
            "device_info": DeviceInfo.hardwareModel(),
            "images": images.map { ["data": $0.base64EncodedString()] },
        ]
    }

    static func send(message: String, images: [Data]) async throws {
        var request = URLRequest(url: feedbackApiUrl)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(
            withJSONObject: body(message: message, images: images))

        guard let (_, response) = try? await URLSession.shared.data(for: request),
            let http = response as? HTTPURLResponse
        else { throw Failed(status: nil) }

        guard (200..<300).contains(http.statusCode) else {
            throw Failed(status: http.statusCode)
        }
    }
}
