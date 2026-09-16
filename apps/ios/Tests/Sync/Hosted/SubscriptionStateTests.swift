import Foundation
import Testing

@testable import FutoNotesNative

/// The subscription in words. The payment provider's vocabulary becomes a
/// sentence exactly here, and a state nobody recognised must still say
/// something true.
@Suite("Subscription state wording")
struct SubscriptionStateTests {
    /// Fixed "now" so the grace-period wording is deterministic.
    private static let now = Date(timeIntervalSince1970: 1_758_000_000)

    private func localization() -> Localization {
        Localization(
            runtimeCatalogs: GeneratedLanguageCatalogs.catalogs,
            requestedLanguageTags: ["en"],
            regionalLanguageTag: "en-US",
            currentTimeMillis: { Self.now.timeIntervalSince1970 * 1_000 },
            reportDiagnostic: { _ in }
        )
    }

    private func billing(
        state: String,
        entitled: Bool = true,
        graceUntil: String? = nil
    ) -> BillingStatus {
        BillingStatus(
            entitled: entitled,
            state: state,
            graceUntil: graceUntil,
            storageQuotaBytes: 10_000_000_000,
            blobMaxBytes: 104_857_600,
            bytesUsed: 4_210_688
        )
    }

    @Test("each state the provider sends has its own wording")
    func knownStates() {
        let cases: [(String, String)] = [
            ("active", "sync.hosted.account.state.active"),
            ("trialing", "sync.hosted.account.state.trialing"),
            ("canceled", "sync.hosted.account.state.expired"),
            ("paused", "sync.hosted.account.state.paused"),
            ("incomplete", "sync.hosted.account.state.incomplete"),
            ("incomplete_expired", "sync.hosted.account.state.incomplete"),
            ("none", "sync.hosted.account.state.none"),
        ]
        for (state, path) in cases {
            #expect(subscriptionStateMessage(billing(state: state), localization()).path == path)
        }
    }

    @Test("a failed payment says when sync will pause")
    func pastDueNamesTheDate() {
        // Four days after the fixed "now".
        let grace = Self.now.addingTimeInterval(4 * 24 * 60 * 60)
        let iso = ISO8601DateFormatter().string(from: grace)
        let local = localization()

        let message = subscriptionStateMessage(
            billing(state: "past_due", entitled: true, graceUntil: iso), local)

        #expect(message.path == "sync.hosted.account.state.pastDue")
        #expect(
            message.arguments["when"] as? String
                == local.localizedRelativeTime(
                    grace.timeIntervalSince1970 * 1_000))
    }

    @Test("a failed payment with no usable date still says the payment failed")
    func pastDueWithoutADate() {
        let local = localization()
        #expect(
            subscriptionStateMessage(billing(state: "past_due", graceUntil: nil), local).path
                == "sync.hosted.account.state.pastDueNoDate")
        #expect(
            subscriptionStateMessage(
                billing(state: "unpaid", graceUntil: "not a date"), local
            ).path == "sync.hosted.account.state.pastDueNoDate")
    }

    @Test("an unrecognised state falls back to the entitlement, never the raw word")
    func unknownStateFallsBack() {
        let local = localization()
        #expect(
            subscriptionStateMessage(billing(state: "dunning", entitled: true), local).path
                == "sync.hosted.account.state.active")
        #expect(
            subscriptionStateMessage(billing(state: "dunning", entitled: false), local).path
                == "sync.hosted.account.state.none")
    }

    @Test("every wording resolves to real English, not a catalog path")
    func everyWordingResolves() {
        let local = localization()
        for state in [
            "active", "trialing", "past_due", "unpaid", "canceled", "paused", "incomplete",
            "incomplete_expired", "none", "something-new",
        ] {
            let message = subscriptionStateMessage(billing(state: state), local)
            let text = local.localizedText(message.path, arguments: message.arguments)
            #expect(text != message.path, "\(state) rendered as its own path")
        }
    }
}
