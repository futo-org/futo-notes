#import <Capacitor/Capacitor.h>

CAP_PLUGIN(FolderImportPlugin, "FolderImport",
    CAP_PLUGIN_METHOD(pickAndReadMarkdownFiles, CAPPluginReturnPromise);
)
