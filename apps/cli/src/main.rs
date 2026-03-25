mod cli;
mod docker;
mod reset_password;
mod server_api;
mod setup;
mod status;
mod update;

use anyhow::Result;
use clap::{CommandFactory, Parser};
use cli::{Cli, Commands};

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Setup(args)) => setup::run(args),
        Some(Commands::Status(args)) => status::run(args),
        Some(Commands::ResetPassword(args)) => reset_password::run(args),
        Some(Commands::Update(args)) => update::run(args),
        Some(Commands::Version) => {
            println!("stonefruit {}", cli::version());
            Ok(())
        }
        None => {
            Cli::command().print_help()?;
            println!();
            Ok(())
        }
    }
}
