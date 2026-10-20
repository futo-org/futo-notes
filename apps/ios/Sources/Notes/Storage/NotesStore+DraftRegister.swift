import Foundation

extension NotesStore {
    /// A newly-appeared editor claims a register entry; returns its unique token.
    /// Entries are keyed by it, so editors overlapping during a push/pop
    /// transition never evict each other's draft (PKT-1 R2).
    func ownsDraft(_ token: UInt64?) -> Bool {
        guard !resetting else { return false }
        guard let token else { return true }
        return token > retiredDraftTokensThrough && token <= draftSeq
    }

    func claimDraftOwnership() -> UInt64 {
        draftSeq += 1
        return draftSeq
    }

    /// The editor publishes (or clears, with `nil`) its DERIVED draft under its
    /// own `token` — called reactively on every state change. Replaces the old
    /// hand-synced set/clear sites: the register reflects the derivation's verdict
    /// (`content != savedContent`) on demand, so a completed save / adopted remote
    /// clears the draft by construction (PKT-1 R1). Never touches another editor's
    /// entry.
    func publishDraft(token: UInt64, _ draft: PendingDraft?) {
        guard !resetting, token > retiredDraftTokensThrough else { return }
        draftRegister[token] = draft
    }

    /// The editor left the screen — removes only its own entry, leaving any
    /// overlapping editor's draft intact.
    func releaseDraftOwnership(token: UInt64) {
        draftRegister[token] = nil
        oneShotDraftTokens.remove(token)
        backgroundEditorFlush.release(token: token)
    }

    /// Keep a leaving editor's final dirty snapshot registered until its
    /// asynchronous flush has durably written or parked the draft.
    func retainDraftUntilFlushed(token: UInt64) {
        backgroundEditorFlush.release(token: token)
        guard draftRegister[token] != nil else { return }
        oneShotDraftTokens.insert(token)
    }

    func completeRetainedDraft(_ draft: PendingDraft) {
        let completedTokens = oneShotDraftTokens.filter { draftRegister[$0] == draft }
        for token in completedTokens {
            draftRegister[token] = nil
            oneShotDraftTokens.remove(token)
        }
    }

    func retainedDraftSnapshot(for id: String) -> [UInt64: PendingDraft] {
        Dictionary(
            uniqueKeysWithValues: oneShotDraftTokens.compactMap { token in
                guard let draft = draftRegister[token], draft.id == id else { return nil }
                return (token, draft)
            })
    }

    func completeRetainedDraftSnapshot(_ snapshot: [UInt64: PendingDraft]) {
        for (token, draft) in snapshot where draftRegister[token] == draft {
            draftRegister[token] = nil
            oneShotDraftTokens.remove(token)
        }
    }

    func discardDrafts(for id: String) {
        let tokens = draftRegister.compactMap { token, draft in draft.id == id ? token : nil }
        for token in tokens {
            draftRegister[token] = nil
            oneShotDraftTokens.remove(token)
        }
    }

    func retargetRetainedDrafts(from oldId: String, to finalId: String) {
        for token in oneShotDraftTokens {
            guard let draft = draftRegister[token], draft.id == oldId else { continue }
            draftRegister[token] = PendingDraft(
                id: finalId,
                base: draft.base,
                content: draft.content
            )
        }
    }

    /// Flush every live editor's pending draft to disk (scenePhase inactive/
    /// background). Coalesces by note id, keeping the highest-token (most recently
    /// claimed = incoming/visible) draft, so two editors overlapping on the SAME
    /// note during a transition issue exactly one conditional write instead of two
    /// racing on the same base (Android parity: LinkedHashMap last-registered wins).
    /// Within a background episode a given id's draft is flushed once UNLESS it
    /// changed since (see `flushedThisEpisode`). No-op when every draft is clean /
    /// closed; safe at every leave-active signal.
    func flushPendingEditor() {
        guard !resetting, !draftRegister.isEmpty else { return }
        var byId: [String: (token: UInt64, draft: PendingDraft)] = [:]
        for (token, draft) in draftRegister {
            if let existing = byId[draft.id], existing.token >= token { continue }
            byId[draft.id] = (token, draft)
        }
        for entry in byId.values {
            let draft = entry.draft
            // Skip only an IDENTICAL re-flush this episode; a draft that changed
            // between .inactive and .background (a keystroke landing right at
            // backgrounding) still flushes, so the newest edit is never lost.
            if flushedThisEpisode[draft.id] == draft { continue }
            flushedThisEpisode[draft.id] = draft
            flushAsync(draft)
        }
    }

    /// Re-arm the per-episode flush snapshot — called on scenePhase `.active` so
    /// the next backgrounding flushes afresh.
    func rearmBackgroundFlush() {
        flushedThisEpisode.removeAll()
    }

    /// The visible editor registers how to await its current mailbox for its
    /// draft before ``requestPendingEditorFlush()`` starts the durable write.
    func setDraftFlushWaiter(
        token: UInt64, _ refresh: @escaping @MainActor () async -> Void
    ) {
        guard !resetting, token > retiredDraftTokensThrough else { return }
        backgroundEditorFlush.register(token: token, wait: refresh)
    }

    func requestPendingEditorFlush() {
        guard !resetting else { return }
        backgroundEditorFlush.run { [weak self] in
            guard let self else { return }
            self.flushPendingEditor()
            await self.waitForEditorFlushes()
        }
    }
}
