import Foundation

struct OpenNoteChange: Equatable {
    var updatedIds: Set<String>
    var deletedIds: Set<String>
    var renamed: [String: String]

    static let external = OpenNoteChange(updatedIds: [], deletedIds: [], renamed: [:])

    init(updatedIds: Set<String>, deletedIds: Set<String>, renamed: [String: String]) {
        self.updatedIds = updatedIds
        self.deletedIds = deletedIds
        self.renamed = renamed
    }

    init(summary: SyncSummary) {
        updatedIds = Set(summary.updatedIds)
        deletedIds = Set(summary.deletedIds)
        renamed = Dictionary(
            summary.renamed.map { ($0.fromId, $0.toId) },
            uniquingKeysWith: { _, latest in latest }
        )
    }

    func affects(_ id: String) -> Bool {
        updatedIds.contains(id) || deletedIds.contains(id) || renamed[id] != nil
    }

    func merging(_ newer: OpenNoteChange) -> OpenNoteChange {
        OpenNoteChange(
            updatedIds: updatedIds.union(newer.updatedIds),
            deletedIds: deletedIds.union(newer.deletedIds),
            renamed: renamed.merging(newer.renamed) { _, latest in latest }
        )
    }
}
