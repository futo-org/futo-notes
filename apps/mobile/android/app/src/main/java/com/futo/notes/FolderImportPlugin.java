package com.futo.notes;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;

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
import java.io.File;
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
                        fileObj.put("lastModified", entry.lastModified());
                        files.add(fileObj);
                    }
                }
            }
        }
    }

    @PluginMethod
    public void setFileModificationTime(PluginCall call) {
        String filename = call.getString("filename");

        if (filename == null || !call.getData().has("mtime")) {
            call.reject("Missing filename or mtime");
            return;
        }

        long mtimeMs = call.getData().optLong("mtime", 0);
        long mtimeSec = mtimeMs / 1000;

        // Update via MediaStore (works with scoped storage on Android 11+)
        ContentResolver resolver = getContext().getContentResolver();
        String relativePath = "Documents/futo-notes/";

        // Find the file in MediaStore by display name and relative path
        Uri filesUri = MediaStore.Files.getContentUri("external");
        String selection = MediaStore.MediaColumns.DISPLAY_NAME + " = ? AND "
                + MediaStore.MediaColumns.RELATIVE_PATH + " = ?";
        String[] selectionArgs = new String[] { filename, relativePath };

        // First query to find the file
        try (Cursor cursor = resolver.query(filesUri, new String[] { MediaStore.MediaColumns._ID },
                selection, selectionArgs, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                long id = cursor.getLong(0);
                Uri fileUri = Uri.withAppendedPath(filesUri, String.valueOf(id));

                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DATE_MODIFIED, mtimeSec);
                int updated = resolver.update(fileUri, values, null, null);
                if (updated > 0) {
                    call.resolve();
                    return;
                }
            }
        } catch (Exception e) {
            // MediaStore approach failed, try fallback
        }

        // Fallback: try direct File API
        File docsDir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOCUMENTS);
        if (docsDir != null) {
            File file = new File(new File(docsDir, "futo-notes"), filename);
            if (file.setLastModified(mtimeMs)) {
                call.resolve();
                return;
            }
        }

        call.reject("Failed to set modification time");
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
