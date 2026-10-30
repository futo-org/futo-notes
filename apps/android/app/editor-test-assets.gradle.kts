import com.android.build.api.dsl.ApplicationExtension

// Own one synthetic fixture asset without packaging neighboring documentation
// beside the existing conformance README. Sync owns this complete output folder.
val generatedEditorTestAssetsDirectory = layout.buildDirectory.dir("generated/editor-test-assets")
val stageEditorTestAssets = tasks.register<Sync>("stageEditorTestAssets") {
    from(rootProject.file("../../crates/futo-notes-editor/tests/fixtures")) {
        include("structural-seams.json")
    }
    into(generatedEditorTestAssetsDirectory)
}

extensions.configure<ApplicationExtension> {
    sourceSets.getByName("androidTest").assets.srcDir(generatedEditorTestAssetsDirectory)
}

// A source directory alone does not make the asset merge wait for its producer.
tasks.named("preBuild").configure {
    dependsOn(stageEditorTestAssets)
}
