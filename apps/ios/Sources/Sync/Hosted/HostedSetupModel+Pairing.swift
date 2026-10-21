import Foundation

extension HostedSetupModel {
    /// Opens a pairing and shows its code until the other device answers.
    ///
    /// One call covers the whole wait: Rust mints the one-time keypair,
    /// publishes the public half to the relay, and polls for the sealed vault
    /// key until the relay's own five minutes are up. What comes back decides
    /// the state, which is why nothing here has its own timer — the countdown
    /// on screen only describes that deadline, it does not enforce it.
    func showPairingCode() async {
        await step { setup in
            self.pairing = .idle
            self.pairingPayload = nil
            let code = try await setup.beginPairing(deviceName: self.shell.deviceName)
            self.pairingPayload = code.payload
            self.pairingExpiresAt = code.expiresAt
            self.pairing = .waiting
            do {
                let outcome = try await setup.awaitPairing()
                self.pairingPayload = nil
                if case .cancelled = outcome {
                    self.pairing = .idle
                    return
                }
                // The key arrived and is kept: this device is unlocked. Said
                // here rather than after the step read, so the code's
                // disappearance is explained while that read is in flight.
                self.pairing = .received
                try await self.readStep(setup)
            } catch {
                self.pairingPayload = nil
                switch error as? HostedError {
                // A person who declined on the other device sent nothing, so
                // this is also what declining looks like from here. The copy
                // says so rather than claiming to know which happened.
                case .PairingExpired:
                    self.pairing = .expired
                case .PairingRefused, .PairingAlreadyKeyed:
                    self.pairing = .refused
                default:
                    self.pairing = .idle
                    throw error
                }
            }
        }
    }

    /// Stops waiting and puts the three doors back. Deliberately outside
    /// `step`: the wait it is canceling is what holds `busy`.
    func cancelPairing() {
        if pairing == .waiting { setup?.cancelWait() }
        pairing = .idle
        pairingPayload = nil
        pairingExpiresAt = nil
    }

    /// Opens the camera on an unlocked device (parent spec user story 15).
    func openScanner() {
        errorMessage = nil
        scannedPairing = nil
        scanPhase = .scanning
    }

    /// One code, from the camera or from a test. Parsing touches no network, no
    /// secret store, and no vault key — all it answers is the name to put on
    /// the confirmation sheet.
    func readScannedCode(_ code: String) async {
        await step { setup in
            self.scannedPairing = try self.parseScanned(setup, code)
            self.scanPhase = .confirming
        }
    }

    /// The confirmation (parent spec user story 16). This is the only thing in
    /// the app that sends a vault key anywhere.
    func sendVaultKey() async {
        guard let scanned = scannedPairing else { return }
        await step { _ in
            self.scanPhase = .sending
            do {
                try await scanned.send()
            } catch {
                // A refused or already-answered pairing cannot be retried, and
                // a locked device has nothing to give: either way the next
                // useful move is a fresh code, so the camera goes back on with
                // the reason on screen.
                self.scannedPairing = nil
                self.scanPhase = .scanning
                throw error
            }
            self.scanPhase = .sent
        }
    }

    /// Said no on the confirmation sheet. Nothing was sent, and nothing is kept.
    func cancelConfirmation() {
        scannedPairing = nil
        errorMessage = nil
        scanPhase = .scanning
    }

    func closeScanner() {
        scannedPairing = nil
        scanPhase = .closed
    }
}
