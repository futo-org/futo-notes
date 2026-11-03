# `*args` is re-split by the shell unless quoted; recipes forwarding user text
# (a label, a pattern, a path) use "$@" instead — see docs/agents/justfile-notes.md.
set positional-arguments

default:
  @just --list --unsorted

alias i := install
alias td := tauri-dev
alias tb := tauri-build
alias an := android-native
alias in := ios-native
alias b := build
alias tu := test-unit
alias l := lint
alias c := check
alias pp := prepush
alias dd := deploy-deb
alias dr := deploy-rpm
alias di := deploy-ios

# Recipes live in just/, one file per job; `just --list` shows them all.
import 'just/setup.justfile'
import 'just/test.justfile'
import 'just/desktop.justfile'
import 'just/mobile.justfile'
import 'just/editor.justfile'
import 'just/qa.justfile'
import 'just/checks.justfile'
