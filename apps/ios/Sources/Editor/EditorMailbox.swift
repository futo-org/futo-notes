import Foundation

struct DocumentSnapshot: Equatable {
    let generation: Int
    let content: String
}

struct EditorCurrent: Equatable {
    let latest: DocumentSnapshot?
    let behind: Bool
    var rendererGone = false
    var canProceed: Bool { !behind || rendererGone }
}

@MainActor
final class EditorMailbox {
    private final class Entry {
        var latest: DocumentSnapshot?
        var editedThrough = 0
        var acceptedThrough = -1
        var gone = false
        var waiters: [String: (Bool) -> Void] = [:]
    }
    private var bindings: [Int: (id: String, change: (String) -> Void)] = [:]
    private var retained: [String: (String) -> Void] = [:]
    func bind(_ owner: Int, id: String, change: @escaping (String) -> Void) {
        bindings[owner] = (id, change)
    }
    func isBound(_ owner: Int) -> Bool { bindings[owner] != nil }
    func detach(_ owner: Int) { bindings.removeValue(forKey: owner) }
    /// A rename: the editor's next report for `from`'s document arrives as `to`.
    func retarget(_ from: String, to: String) {
        for (owner, binding) in bindings where binding.id == from {
            bindings[owner] = (to, binding.change)
        }
    }
    func retainUnflushed(_ id: String, deliver: @escaping (String) -> Void) {
        if !current(id).canProceed { retained[id] = deliver }
    }
    private var entries: [String: Entry] = [:]
    private func entry(_ id: String) -> Entry {
        if let m = entries[id] { return m }
        let m = Entry()
        entries[id] = m
        return m
    }
    func current(_ id: String) -> EditorCurrent {
        let m = entry(id)
        return EditorCurrent(
            latest: m.latest, behind: (m.latest?.generation ?? 0) < m.editedThrough,
            rendererGone: m.gone)
    }
    func prepareLoad(_ id: String) {
        let m = entry(id)
        guard current(id).canProceed else { return }
        m.latest = nil
        m.editedThrough = 0
    }
    func loaded(_ id: String, generation: Int, content: String) {
        let m = entry(id)
        if m.gone {
            m.latest = nil
            m.editedThrough = 0
            m.acceptedThrough = -1
            m.gone = false
        }
        guard generation >= m.acceptedThrough else { return }
        m.latest = DocumentSnapshot(generation: generation, content: content)
        m.acceptedThrough = generation
        m.editedThrough = max(m.editedThrough, generation)
        satisfy(id)
    }
    func edited(_ id: String, generation: Int) {
        let m = entry(id)
        if generation > m.acceptedThrough { m.editedThrough = max(m.editedThrough, generation) }
    }
    @discardableResult
    func change(_ id: String, generation: Int, content: String) -> Bool {
        let m = entry(id)
        guard generation > m.acceptedThrough else {
            satisfy(id)
            return false
        }
        m.latest = DocumentSnapshot(generation: generation, content: content)
        m.acceptedThrough = generation
        // Covered views sharing this id must not acquire a second stale-base draft.
        bindings.filter { $0.value.id == id }.max(by: { $0.key < $1.key })?.value.change(content)
        if current(id).canProceed { retained.removeValue(forKey: id)?(content) }
        satisfy(id)
        return true
    }
    private func satisfy(_ id: String) {
        guard current(id).canProceed else { return }
        for answer in Array(entry(id).waiters.values) { answer(true) }
    }
    func failed(_ id: String, token: String) { entry(id).waiters[token]?(false) }
    func prune(keeping activeId: String) {
        for (id, m) in entries
        where id != activeId && m.waiters.isEmpty
            && retained[id] == nil && !bindings.values.contains(where: { $0.id == id })
            && current(id).canProceed
        {
            entries.removeValue(forKey: id)
        }
    }
    func rendererGone() {
        retained.removeAll()
        for m in entries.values {
            m.gone = true
            for answer in Array(m.waiters.values) { answer(false) }
        }
    }
    /// Wait for the document identity handoff before conditional adoption.
    func awaitLoaded(_ id: String, deadline: TimeInterval = 6, load: () -> Void) async
        -> EditorCurrent
    {
        let now = current(id)
        guard now.latest == nil, !now.rendererGone else { return now }
        let token = UUID().uuidString
        let m = entry(id)
        _ = await awaitEditorSignal(deadline: deadline) { answer in
            m.waiters[token] = answer
            load()
        }
        m.waiters.removeValue(forKey: token)
        return current(id)
    }
    func awaitCurrent(_ id: String, deadline: TimeInterval = 6, flush: (String) -> Void) async
        -> EditorCurrent
    {
        let now = current(id)
        guard !now.canProceed else { return now }
        let token = UUID().uuidString
        let m = entry(id)
        _ = await awaitEditorSignal(deadline: deadline) { answer in
            m.waiters[token] = answer
            flush(token)
        }
        m.waiters.removeValue(forKey: token)
        return current(id)
    }
}

/// Bounded, cancellation-aware wait for an outbound protocol event. No document read.
@MainActor
func awaitEditorSignal(deadline: TimeInterval = 6, start: (@escaping (Bool) -> Void) -> Void) async
    -> Bool
{
    let wait = EditorSignalWait()
    return await withTaskCancellationHandler {
        await withCheckedContinuation { continuation in
            wait.continuation = continuation
            if Task.isCancelled {
                wait.resolve(false)
                return
            }
            wait.deadline = Task { @MainActor in
                do { try await Task.sleep(for: .seconds(deadline)) } catch { return }
                wait.resolve(false)
            }
            start { wait.resolve($0) }
        }
    } onCancel: {
        Task { @MainActor in wait.resolve(false) }
    }
}

@MainActor
private final class EditorSignalWait {
    var continuation: CheckedContinuation<Bool, Never>?
    var deadline: Task<Void, Never>?
    func resolve(_ value: Bool) {
        let pending = continuation
        continuation = nil
        deadline?.cancel()
        deadline = nil
        pending?.resume(returning: value)
    }
}
