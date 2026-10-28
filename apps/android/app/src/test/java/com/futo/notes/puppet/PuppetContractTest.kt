package com.futo.notes.puppet

import android.view.WindowManager.LayoutParams
import androidx.compose.ui.unit.IntRect
import com.futo.notes.ui.navigation.Screen
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The listener's pure half. `futo-puppet` reads these answers literally — a screen
 * name that differs from iOS, or a forwarded reply that loses its status, sends
 * the caller down a path the app never took.
 */
class PuppetContractTest {
    /**
     * The tree starts at the topmost window that takes every touch. A text caret's handle is
     * a popup too, but it cannot take focus, which Android treats as never touch-modal; read
     * as a dialog, its 41×50 px window blanked the search screen whenever the keyboard was up.
     */
    @Test
    fun onlyAWindowThatCanTakeFocusHoldsEveryTouch() {
        val panel = LayoutParams.TYPE_APPLICATION_SUB_PANEL
        assertTrue(PuppetContract.touchModal(LayoutParams.TYPE_APPLICATION, 0))
        assertTrue(PuppetContract.touchModal(panel, 0))
        // The handle's flags, read from `dumpsys window` on the search screen.
        val caretHandle = LayoutParams.FLAG_NOT_FOCUSABLE or LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
        assertFalse(PuppetContract.touchModal(panel, caretHandle))
        assertFalse(PuppetContract.touchModal(panel, LayoutParams.FLAG_NOT_TOUCH_MODAL))
        assertFalse(PuppetContract.touchModal(LayoutParams.TYPE_BASE_APPLICATION, 0))
    }

    /** Only adbd, the shell user (root after `adb root`), may drive the app: never another app. */
    @Test
    fun onlyAdbMayConnect() {
        assertTrue(PuppetContract.mayConnect(2000))
        assertTrue(PuppetContract.mayConnect(0))
        assertFalse(PuppetContract.mayConnect(10_123))
        assertFalse(PuppetContract.mayConnect(1000))
    }

    @Test
    fun routesAreTheFourShapesTheCliSpeaks() {
        assertEquals(PuppetRoute.Actions, PuppetContract.route("GET", "/actions"))
        assertEquals(PuppetRoute.Tree, PuppetContract.route("GET", "/tree"))
        assertEquals(PuppetRoute.Verb("Bold"), PuppetContract.route("POST", "/do/Bold"))
        assertEquals(PuppetRoute.Query("state"), PuppetContract.route("POST", "/state"))
        // `drive` is built on `observe`, and a driver sees the vault through `notes`.
        assertEquals(PuppetRoute.Query("observe"), PuppetContract.route("POST", "/observe"))
        assertEquals(PuppetRoute.Query("notes"), PuppetContract.route("POST", "/notes"))
        // Method and path both have to match: a query is never a GET, and only
        // the known query names are routes at all.
        assertNull(PuppetContract.route("GET", "/state"))
        assertNull(PuppetContract.route("POST", "/actions"))
        assertNull(PuppetContract.route("POST", "/do/"))
        assertNull(PuppetContract.route("POST", "/frobnicate"))
    }

    @Test
    fun searchTakesTheQueryAsSentAndAPositiveLimit() {
        assertEquals(PuppetRoute.Query("search"), PuppetContract.route("POST", "/search"))
        assertEquals("lease " to 10u, PuppetContract.searchRequest("""{"query":"lease "}"""))
        assertEquals("lease" to 3u, PuppetContract.searchRequest("""{"query":"lease","limit":3}"""))
        for (refused in listOf(
            "{}",
            """{"query":"  "}""",
            """{"query":"x","limit":0}""",
            """{"query":"x","limit":"3"}""",
        )) {
            assertNull(PuppetContract.searchRequest(refused))
        }
    }

    @Test
    fun theVaultRootReportsAsTheListScreen() {
        // Android's home screen IS the root folder; iOS calls the same place
        // "list", and a scenario has to read the same on both.
        assertEquals("list", PuppetContract.screen(Screen.Folder("")))
        assertEquals("folder:work/2026", PuppetContract.screen(Screen.Folder("work/2026")))
        assertEquals(
            "editor:work/note",
            PuppetContract.screen(Screen.Editor("work/note", autoFocus = false)),
        )
        // A rename in place moves the note; the entry keeps the id it was pushed with.
        assertEquals(
            "editor:work/renamed",
            PuppetContract.screen(Screen.Editor("work/note", autoFocus = false), "work/renamed"),
        )
        // Screens iOS has no counterpart for are still named, not hidden.
        assertEquals("settings", PuppetContract.screen(Screen.Settings))
        assertEquals("search", PuppetContract.screen(Screen.Search))
    }

    private fun names(screen: Screen, canGoBack: Boolean) = PuppetContract.nativeNames(screen, canGoBack)

    @Test
    fun goBackIsOfferedOnlyWhenThereIsSomewhereToGo() {
        val root = Screen.Folder("")
        assertEquals(
            listOf("GoBack"),
            names(root, canGoBack = true) - names(root, canGoBack = false).toSet(),
        )
        // A row's tap. The list's other controls are the list screen's own verbs.
        assertEquals(listOf("OpenNote", "OpenFolder"), names(root, canGoBack = false))
    }

    @Test
    fun eachNativeScreenOffersItsOwnControlsAndNothingElse() {
        // Every name here is a verb the listener dispatches.
        val all = listOf(
            Screen.Folder(""), Screen.Folder("a"), Screen.Editor("n", autoFocus = false),
            Screen.Search, Screen.Settings, Screen.StorageLocation, Screen.Sync, Screen.Feedback,
        )
        for (screen in all) {
            val offered = names(screen, canGoBack = true)
            assert(PuppetContract.nativeControls.keys.containsAll(offered)) { "$screen offers $offered" }
        }
        assertEquals(
            listOf("OpenNote", "SetSearchQuery", "ClearSearchQuery", "GoBack"),
            names(Screen.Search, canGoBack = true),
        )
        // A screen with no rows: its controls are the verbs it registers itself.
        for (screen in listOf(Screen.Editor("n", autoFocus = false), Screen.Settings, Screen.Sync, Screen.Feedback)) {
            assertEquals(listOf("GoBack"), names(screen, canGoBack = true))
        }
    }

    @Test
    fun aSchemaTypesEachArgumentAndRequiresOnlyTheRequired() {
        val schema = PuppetContract.schema(listOf("noteId"), listOf("title"))
        assertEquals(
            setOf("noteId", "title"),
            schema.getJSONObject("properties").keys().asSequence().toSet(),
        )
        assertEquals("[\"noteId\"]", schema.getJSONArray("required").toString())
        val direction = PuppetContract.schema(listOf("direction"), integers = listOf("direction"))
        assertEquals(
            "integer",
            direction.getJSONObject("properties").getJSONObject("direction").getString("type"),
        )
        // An answer is confirm or dismiss wherever it is taken.
        val answer = PuppetContract.schema(listOf("noteId"), optional = listOf("answer"))
            .getJSONObject("properties").getJSONObject("answer")
        assertEquals("""["confirm","dismiss"]""", answer.getJSONArray("enum").toString())
    }

    @Test
    fun aForwardedReplyKeepsItsStatusAndBody() {
        val forwarded = PuppetContract.response("""{"status":409,"body":{"ok":false,"error":"no"}}""")
        assertEquals(409, forwarded.status)
        assertEquals("no", JSONObject(forwarded.body).getString("error"))
    }

    @Test
    fun aMissingOrMalformedWebviewReplyIsARefusal() {
        // No inspector yet: the page is still booting, so the caller should retry.
        assertEquals(503, PuppetContract.response(null).status)
        // Anything that is not {status, body} is the webview breaking its contract.
        assertEquals(502, PuppetContract.response("not json").status)
        assertEquals(502, PuppetContract.response("""{"body":{}}""").status)
    }

    @Test
    fun aListVerbRefusedInTheEditorSaysToGoBackFirst() {
        val editor = Screen.Editor("a", autoFocus = false)
        assert("GoBack first" in PuppetContract.offScreen("OpenNote", editor))
        assertEquals("no such verb on this screen: Frobnicate", PuppetContract.offScreen("Frobnicate", editor))
        assertEquals("no such verb on this screen: OpenSync", PuppetContract.offScreen("OpenSync", Screen.Folder("")))
    }

    /** A Settings verb asked on the list leads with "not on this screen", not with a missing editor. */
    @Test
    fun aVerbNotOfferedOffTheEditorIsNotOnThisScreen() {
        val refused = requireOpenEditor(Screen.Folder(""), "SetTheme")!!
        assertEquals(404, refused.status)
        assert(JSONObject(refused.body).getString("error").startsWith("no such verb on this screen: SetTheme"))
        assertNull(requireOpenEditor(Screen.Editor("a", autoFocus = false), "SetTheme"))
    }

    @Test
    fun pageQueriesAreTheWebviewsAndTheBuffersAreNot() {
        // Off the editor these would answer about the note the WebView still holds.
        assert(PuppetContract.pageQueries.all { it in PuppetContract.queries })
        assert("elements" in PuppetContract.pageQueries && "doc" in PuppetContract.pageQueries)
        // The agent's clipboard and the shell's own answers survive navigation.
        for (query in listOf("clipboard", "state", "notes", "file", "observe", "touches")) {
            assert(query in PuppetContract.queries && query !in PuppetContract.pageQueries) { query }
        }
    }

    @Test
    fun theVaultIsEveryNoteAndFolderSortedWithTimesOnlyWhenAsked() {
        val vault = PuppetContract.vault(listOf("b", "a/c"), listOf("z", "a"))
        assertEquals("[\"a/c\",\"b\"]", vault.getJSONArray("notes").toString())
        assertEquals("[\"a\",\"z\"]", vault.getJSONArray("folders").toString())
        assert(!vault.has("modified"))
        val timed = PuppetContract.vault(listOf("a"), emptyList(), mapOf("a" to 1_700_000_000_000L))
        assertEquals(1_700_000_000_000L, timed.getJSONObject("modified").getLong("a"))
    }

    @Test
    fun controlsAreEachVerbByWhatItsLabelsReadInTheAppLanguage() {
        val labels = PuppetContract.controlLabels(
            listOf(
                "DeleteNote" to listOf("common.actions.delete"),
                "DeleteFolder" to listOf("common.actions.delete"),
                "GoBack" to listOf("common.actions.back"),
                "OpenNote" to emptyList(),
            ),
        ) { key -> mapOf("common.actions.delete" to "Löschen", "common.actions.back" to "Zurück").getValue(key) }
        assertEquals("[\"DeleteNote\",\"DeleteFolder\"]", labels.getJSONArray("Löschen").toString())
        assertEquals("[\"GoBack\"]", labels.getJSONArray("Zurück").toString())
        assertEquals(2, labels.length())
    }

    @Test
    fun settingsAreTheWholePrefsFileWithTheSyncPasswordAsWhetherItIsSet() {
        val settings = PuppetContract.storedSettings(
            mapOf(
                "theme_mode" to "DARK",
                "crash_always_send" to true,
                "sync_password_ct" to "c2VjcmV0",
                "sync_password_iv" to null,
                "tags" to setOf("b", "a"),
            ),
        )
        assertEquals("DARK", settings.getString("theme_mode"))
        assertEquals(true, settings.getBoolean("crash_always_send"))
        assertEquals("set", settings.getString("sync_password_ct"))
        assert(settings.isNull("sync_password_iv"))
        assertEquals("[\"a\",\"b\"]", settings.getJSONArray("tags").toString())
    }

    @Test
    fun aConvenienceVerbSaysSoAndARealOneSaysNothing() {
        val scroll = PuppetContract.actionEntry(PuppetVerb("ScrollToRow", convenience = true) {})
        assertEquals("ScrollToRow", scroll.getString("name"))
        assert(scroll.getBoolean("convenience"))
        assertFalse(PuppetContract.actionEntry(PuppetVerb("SetTitle") {}).has("convenience"))
    }

    @Test
    fun aShortcutArgumentListsTheStepsItStandsFor() {
        val open = PuppetContract.actionEntry(
            PuppetVerb(
                "OpenCreateFolderDialog",
                optional = listOf("name"),
                shortcuts = mapOf(
                    "name" to listOf("SetNewFolderName" to mapOf("name" to "\$"), "SubmitNewFolder" to emptyMap()),
                ),
            ) {},
        )
        assertEquals(
            """{"name":[["SetNewFolderName",{"name":"$"}],["SubmitNewFolder",{}]]}""",
            open.getJSONObject("shortcuts").toString(),
        )
        // The argument is still an optional one of the verb's own.
        assertEquals("[]", open.getJSONObject("schema").getJSONArray("required").toString())
        assert(open.getJSONObject("schema").getJSONObject("properties").has("name"))
        assertFalse(PuppetContract.actionEntry(PuppetVerb("SubmitNewFolder") {}).has("shortcuts"))
        // A shortcut is something the agent may leave out, so it cannot be required.
        assertThrows(IllegalArgumentException::class.java) {
            PuppetVerb("RenameFolder", required = listOf("name"), shortcuts = mapOf("name" to emptyList())) {}
        }
    }

    @Test
    fun aCoverCutsOnlyASideItSpansWhole() = with(PuppetContract) {
        val row = IntRect(0, 100, 100, 200)
        assertEquals(row, row.uncoveredBy(IntRect(0, 300, 100, 400)))
        assertEquals(IntRect(0, 150, 100, 200), row.uncoveredBy(IntRect(-10, 0, 110, 150)))
        assertEquals(IntRect(0, 100, 100, 180), row.uncoveredBy(IntRect(0, 180, 100, 400)))
        assertEquals(IntRect(40, 100, 100, 200), row.uncoveredBy(IntRect(-5, 90, 40, 210)))
        assertEquals(IntRect(0, 100, 60, 200), row.uncoveredBy(IntRect(60, 90, 140, 210)))
        assertEquals(row, row.uncoveredBy(IntRect(80, 180, 120, 220)))
        assertNull(row.uncoveredBy(IntRect(-1, 99, 101, 201)))
    }
}
