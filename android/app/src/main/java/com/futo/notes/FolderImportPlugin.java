package com.futo.notes;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "FolderImport")
public class FolderImportPlugin extends Plugin {

    @PluginMethod
    public void pickAndReadMarkdownFiles(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        startActivityForResult(call, intent, "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Folder selection cancelled");
            return;
        }

        Uri treeUri = result.getData().getData();
        if (treeUri == null) {
            call.reject("No folder selected");
            return;
        }

        DocumentFile tree = DocumentFile.fromTreeUri(getContext(), treeUri);
        if (tree == null) {
            call.reject("Cannot access folder");
            return;
        }

        List<JSObject> files = new ArrayList<>();
        enumerateAndRead(tree, "", files);

        JSArray filesArray = new JSArray();
        for (JSObject file : files) {
            filesArray.put(file);
        }

        JSObject ret = new JSObject();
        ret.put("files", filesArray);
        call.resolve(ret);
    }

    private void enumerateAndRead(DocumentFile dir, String relativePath, List<JSObject> files) {
        if (dir == null) return;

        for (DocumentFile entry : dir.listFiles()) {
            if (entry.isDirectory()) {
                String name = entry.getName();
                // Skip hidden directories (.obsidian, .trash, etc.)
                if (name != null && !name.startsWith(".")) {
                    String childPath = relativePath.isEmpty() ? name : relativePath + "/" + name;
                    enumerateAndRead(entry, childPath, files);
                }
            } else if (entry.isFile()) {
                String name = entry.getName();
                if (name != null && name.endsWith(".md")) {
                    String content = readFileContent(entry.getUri());
                    if (content != null) {
                        JSObject fileObj = new JSObject();
                        fileObj.put("name", name.substring(0, name.length() - 3));
                        fileObj.put("path", relativePath);
                        fileObj.put("content", content);
                        files.add(fileObj);
                    }
                }
            }
        }
    }

    private String readFileContent(Uri uri) {
        ContentResolver resolver = getContext().getContentResolver();
        try (InputStream is = resolver.openInputStream(uri)) {
            if (is == null) return null;
            BufferedReader reader = new BufferedReader(
                new InputStreamReader(is, StandardCharsets.UTF_8)
            );
            StringBuilder sb = new StringBuilder();
            char[] buf = new char[4096];
            int read;
            while ((read = reader.read(buf)) != -1) {
                sb.append(buf, 0, read);
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }
}
