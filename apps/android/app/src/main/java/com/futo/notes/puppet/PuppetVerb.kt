package com.futo.notes.puppet

import org.json.JSONObject

/**
 * One control on a Compose screen, as a `futo-puppet` verb: the native counterpart of
 * `registerPuppetVerbs` (src/app/puppet/puppetRegistry.ts) and iOS's `PuppetVerbs.Verb`.
 * A screen declares its own controls with [PuppetVerbScope] while it is on screen, and
 * the debug listener runs them without knowing anything about the screen's state.
 *
 * Lives in `main` because the screens build these in every build; only the debug
 * source set's [PuppetVerbScope] ever holds one, so a release build carries the call
 * sites and registers nothing — the same split as iOS's `#if DEBUG` registry.
 *
 * [run] executes on the main thread, like the tap it stands in for, and returns the fields
 * its receipt adds as a `Map`, or nothing (any other value). Every argument is
 * a string unless its name is in [integers] or [booleans] (a checkbox's state). A [convenience] verb is no control's act
 * (ScrollToRow jumps the list with no finger on it); `/actions` says so, and the CLI
 * prints it as not real input. [controls] are the catalog keys of the labels of the
 * controls it stands for, so a row reads `→ Verb` and `just check-puppet-verbs` holds
 * every labelled control to a verb.
 *
 * [shortcuts] are optional arguments that take the next steps for the agent: argument name →
 * the verbs a person would take after this one, in order, each with its arguments, where
 * `"$"` (as a step's verb or an argument's value) stands for the value the agent gave. The
 * CLI expands them — it runs this verb, then the steps — so [run] ignores a shortcut
 * argument and must not act on one.
 */
internal class PuppetVerb(
    val name: String,
    val required: List<String> = emptyList(),
    val optional: List<String> = emptyList(),
    val integers: List<String> = emptyList(),
    val booleans: List<String> = emptyList(),
    val convenience: Boolean = false,
    val controls: List<String> = emptyList(),
    val shortcuts: Map<String, List<Pair<String, Map<String, String>>>> = emptyMap(),
    val run: suspend (JSONObject) -> Any?,
) {
    init {
        require(shortcuts.keys.all { it in optional }) { "$name: a shortcut argument must be optional" }
    }
}

/** A verb saying no: the same status and sentence the listener's own refusals use. */
internal class PuppetVerbRefusal(val status: Int, override val message: String) : Exception(message)
