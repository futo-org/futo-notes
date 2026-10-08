/*
 * A minimal WebKitGTK window for scripts/perf/block-drag-bench.mjs: loads one
 * URL, waits for the page to post a message to `window.webkit.messageHandlers
 * .bench`, prints that message to stdout and exits 0. Exits 2 on timeout and 3
 * on a load failure.
 *
 * A message that is exactly "snapshot:<path>" is not the result: the host
 * saves a PNG of the visible page to <path>, then calls the page's
 * `window.__benchSnapshotDone()` and keeps waiting.
 *
 * It exists because this is the engine the desktop app ships — the system
 * webkit2gtk-4.1 that Tauri links on Linux — and Playwright's own WebKit build
 * does not even start on Fedora 44 (it wants ICU 74, libjpeg 8 and libjxl 0.8).
 *
 *   webkitgtk-host <url> [timeout-seconds] [width] [height]
 *
 * The window is a real, mapped window: a page only gets animation frames while
 * the compositor shows it, and the benchmark's scroll test needs them.
 */
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int exit_code = 2;
static WebKitWebView *web_view = NULL;

static void on_snapshot(GObject *source, GAsyncResult *result, gpointer data) {
  char *path = data;
  GError *error = NULL;
  cairo_surface_t *surface = webkit_web_view_get_snapshot_finish(WEBKIT_WEB_VIEW(source), result, &error);
  if (surface) {
    cairo_surface_write_to_png(surface, path);
    cairo_surface_destroy(surface);
  } else {
    fprintf(stderr, "webkitgtk-host: snapshot failed: %s\n", error ? error->message : "unknown");
    g_clear_error(&error);
  }
  g_free(path);
  webkit_web_view_evaluate_javascript(web_view, "window.__benchSnapshotDone && window.__benchSnapshotDone()", -1,
                                      NULL, NULL, NULL, NULL, NULL);
}

static void on_message(WebKitUserContentManager *manager, WebKitJavascriptResult *result, gpointer data) {
  (void)manager;
  (void)data;
  JSCValue *value = webkit_javascript_result_get_js_value(result);
  char *text = jsc_value_to_string(value);
  if (g_str_has_prefix(text, "snapshot:")) {
    webkit_web_view_get_snapshot(web_view, WEBKIT_SNAPSHOT_REGION_VISIBLE, WEBKIT_SNAPSHOT_OPTIONS_NONE, NULL,
                                 on_snapshot, g_strdup(text + strlen("snapshot:")));
    g_free(text);
    return;
  }
  fputs(text, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  g_free(text);
  exit_code = 0;
  gtk_main_quit();
}

static gboolean on_load_failed(WebKitWebView *view, WebKitLoadEvent event, char *uri, GError *error, gpointer data) {
  (void)view;
  (void)event;
  (void)data;
  fprintf(stderr, "webkitgtk-host: failed to load %s: %s\n", uri, error->message);
  exit_code = 3;
  gtk_main_quit();
  return TRUE;
}

static gboolean on_timeout(gpointer data) {
  (void)data;
  fprintf(stderr, "webkitgtk-host: timed out waiting for the page\n");
  gtk_main_quit();
  return G_SOURCE_REMOVE;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: webkitgtk-host <url> [timeout-seconds] [width] [height]\n");
    return 64;
  }
  int timeout = argc > 2 ? atoi(argv[2]) : 300;
  int width = argc > 3 ? atoi(argv[3]) : 1280;
  int height = argc > 4 ? atoi(argv[4]) : 800;

  gtk_init(&argc, &argv);

  WebKitUserContentManager *manager = webkit_user_content_manager_new();
  g_signal_connect(manager, "script-message-received::bench", G_CALLBACK(on_message), NULL);
  webkit_user_content_manager_register_script_message_handler(manager, "bench");

  WebKitWebView *view = WEBKIT_WEB_VIEW(webkit_web_view_new_with_user_content_manager(manager));
  web_view = view;
  WebKitSettings *settings = webkit_web_view_get_settings(view);
  webkit_settings_set_enable_developer_extras(settings, TRUE);
  g_signal_connect(view, "load-failed", G_CALLBACK(on_load_failed), NULL);

  GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_title(GTK_WINDOW(window), "block-drag-bench");
  gtk_window_set_default_size(GTK_WINDOW(window), width, height);
  gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(view));
  g_signal_connect(window, "destroy", G_CALLBACK(gtk_main_quit), NULL);
  gtk_widget_show_all(window);

  g_timeout_add_seconds(timeout, on_timeout, NULL);
  webkit_web_view_load_uri(view, argv[1]);
  gtk_main();
  return exit_code;
}
