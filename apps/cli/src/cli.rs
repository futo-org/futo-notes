//! The argument grammar. Built at runtime so every help line is a catalog
//! message; command names and flags are the stable, untranslated protocol.

use std::path::PathBuf;

use clap::{value_parser, Arg, ArgAction, ArgGroup, Command};

use crate::i18n::t;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn template() -> String {
    format!(
        "{{about-with-newline}}\n{} {{usage}}\n\n{{all-args}}{{after-help}}",
        t("cli.help.usageHeading")
    )
}

fn sub(name: &'static str, about: &str) -> Command {
    Command::new(name)
        .about(about.to_owned())
        .help_template(template())
        .next_help_heading(t("cli.help.optionsHeading"))
        .disable_help_flag(true)
        .arg(help_arg())
}

fn help_arg() -> Arg {
    Arg::new("help")
        .short('h')
        .long("help")
        .action(ArgAction::Help)
        .help(t("cli.help.help"))
}

fn flag(name: &'static str, help: &str) -> Arg {
    Arg::new(name)
        .long(name)
        .action(ArgAction::SetTrue)
        .help(help.to_owned())
}

fn value(name: &'static str, value_name: &str, help: &str) -> Arg {
    Arg::new(name)
        .long(name)
        .value_name(value_name.to_owned())
        .help(help.to_owned())
}

fn positional(name: &'static str, value_name: &str, help: &str) -> Arg {
    Arg::new(name)
        .required(true)
        .value_name(value_name.to_owned())
        .help(help.to_owned())
}

fn id_arg() -> Arg {
    positional("id", &t("cli.help.valueId"), &t("cli.help.id"))
}

fn limit_arg(help: &str) -> Arg {
    value("limit", &t("cli.help.valueN"), help).value_parser(value_parser!(u64).range(1..))
}

fn body_args(command: Command) -> Command {
    command
        .arg(value("body", &t("cli.help.valueText"), &t("cli.help.body")).allow_hyphen_values(true))
        .arg(flag("stdin", &t("cli.help.stdin")))
        .group(
            ArgGroup::new("source")
                .args(["body", "stdin"])
                .required(true),
        )
}

pub fn command() -> Command {
    let global = |arg: Arg| arg.global(true).help_heading(t("cli.help.globalHeading"));
    Command::new("futo-notes")
        .version(version())
        .about(t("cli.help.about"))
        .after_help(t("cli.help.afterHelp"))
        .help_template(template())
        .subcommand_help_heading(t("cli.help.commandsHeading"))
        .next_help_heading(t("cli.help.optionsHeading"))
        .subcommand_required(true)
        .disable_help_subcommand(true)
        .disable_help_flag(true)
        .disable_version_flag(true)
        .arg(help_arg())
        .arg(
            Arg::new("version")
                .short('V')
                .long("version")
                .action(ArgAction::Version)
                .help(t("cli.help.version")),
        )
        .arg(global(
            value("vault", &t("cli.help.valuePath"), &t("cli.help.vault"))
                .value_parser(value_parser!(PathBuf)),
        ))
        .arg(global(flag("json", &t("cli.help.json"))))
        .subcommand(
            sub("init", &t("cli.help.init")).arg(
                positional("path", &t("cli.help.valuePath"), &t("cli.help.initPath"))
                    .value_parser(value_parser!(PathBuf)),
            ),
        )
        .subcommand(sub("status", &t("cli.help.status")))
        .subcommand(
            sub("auth", &t("cli.help.auth"))
                .subcommand_required(true)
                .disable_help_subcommand(true)
                .subcommand_help_heading(t("cli.help.commandsHeading"))
                .subcommand(
                    sub("login", &t("cli.help.login"))
                        .arg(
                            value("server", &t("cli.help.valueUrl"), &t("cli.help.server"))
                                .required(true),
                        )
                        .arg(value(
                            "password-command",
                            &t("cli.help.valueCommand"),
                            &t("cli.help.passwordCommand"),
                        )),
                )
                .subcommand(sub("logout", &t("cli.help.logout"))),
        )
        .subcommand(
            sub("list", &t("cli.help.list"))
                .arg(
                    value(
                        "folder",
                        &t("cli.help.valueFolder"),
                        &t("cli.help.listFolder"),
                    )
                    .allow_hyphen_values(true),
                )
                .arg(limit_arg(&t("cli.help.listLimit"))),
        )
        .subcommand(sub("read", &t("cli.help.read")).arg(id_arg()))
        .subcommand(
            sub("search", &t("cli.help.search"))
                .arg(positional(
                    "query",
                    &t("cli.help.valueQuery"),
                    &t("cli.help.query"),
                ))
                .arg(limit_arg(&t("cli.help.searchLimit"))),
        )
        .subcommand(body_args(
            sub("create", &t("cli.help.create")).arg(id_arg()),
        ))
        .subcommand(body_args(
            sub("append", &t("cli.help.append")).arg(id_arg()),
        ))
        .subcommand(sub("edit", &t("cli.help.edit")).arg(id_arg()))
        .subcommand(
            sub("rename", &t("cli.help.rename"))
                .arg(id_arg())
                .arg(positional(
                    "title",
                    &t("cli.help.valueTitle"),
                    &t("cli.help.newTitle"),
                )),
        )
        .subcommand(
            sub("move", &t("cli.help.move")).arg(id_arg()).arg(
                value(
                    "folder",
                    &t("cli.help.valueFolder"),
                    &t("cli.help.moveFolder"),
                )
                .required(true)
                .allow_hyphen_values(true),
            ),
        )
        .subcommand(sub("sync", &t("cli.help.sync")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_grammar_is_internally_consistent() {
        command().debug_assert();
    }

    #[test]
    fn globals_work_before_or_after_the_subcommand() {
        for argv in [
            vec!["futo-notes", "--json", "--vault", "/v", "list"],
            vec!["futo-notes", "list", "--json", "--vault", "/v"],
        ] {
            let matches = command().try_get_matches_from(argv).unwrap();
            assert!(matches.get_flag("json"));
            assert_eq!(
                matches.get_one::<PathBuf>("vault").unwrap(),
                &PathBuf::from("/v")
            );
        }
    }

    #[test]
    fn ids_starting_with_a_dash_need_the_terminator() {
        assert!(command()
            .try_get_matches_from(["futo-notes", "read", "-note"])
            .is_err());
        let matches = command()
            .try_get_matches_from(["futo-notes", "read", "--", "-note"])
            .unwrap();
        let (_, read) = matches.subcommand().unwrap();
        assert_eq!(read.get_one::<String>("id").unwrap(), "-note");
    }

    #[test]
    fn create_needs_exactly_one_body_source() {
        let parse = |argv: &[&str]| command().try_get_matches_from(argv);
        assert!(parse(&["futo-notes", "create", "n"]).is_err());
        assert!(parse(&["futo-notes", "create", "n", "--body", "x", "--stdin"]).is_err());
        assert!(parse(&["futo-notes", "create", "n", "--body", ""]).is_ok());
    }

    #[test]
    fn login_requires_a_server() {
        assert!(command()
            .try_get_matches_from(["futo-notes", "auth", "login"])
            .is_err());
    }
}
