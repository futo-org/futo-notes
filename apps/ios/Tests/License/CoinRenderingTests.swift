import Testing

@testable import FutoNotesNative

@Suite("Coin rendering")
struct CoinRenderingTests {
    @Test("only FUTO_STILL_COIN=1 swaps the RealityKit coin for the still one")
    func stillOnlyOptIn() {
        #expect(CoinRendering.stillOnly(environment: ["FUTO_STILL_COIN": "1"]))
        #expect(!CoinRendering.stillOnly(environment: [:]))
        #expect(!CoinRendering.stillOnly(environment: ["FUTO_STILL_COIN": "0"]))
        #expect(!CoinRendering.stillOnly(environment: ["FUTO_STILL_COIN": ""]))
    }
}
