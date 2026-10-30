// Own explicit synthetic fixture assets without packaging neighboring documentation
// beside the existing conformance README. Sync owns this complete output folder.
val generatedEditorTestAssetsDirectory = layout.buildDirectory.dir("generated/editor-test-assets")
val stageEditorTestAssets = tasks.register<Sync>("stageEditorTestAssets") {
    from(rootProject.file("../../crates/futo-notes-editor/tests/fixtures")) {
        include("structural-seams.json", "list-actions.json", "list-shortcuts.json")
    }
    into(generatedEditorTestAssetsDirectory)
}

// A source directory alone does not make the asset merge wait for its producer.
tasks.named("preBuild").configure {
    dependsOn(stageEditorTestAssets)
}
