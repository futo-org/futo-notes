use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "stonefruit",
    version = version(),
    about = "Self-hosted notes server CLI"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// Run the setup wizard to deploy a Stonefruit server
    Setup(SetupArgs),
    /// Show server status
    Status(StatusArgs),
    /// Print version
    Version,
}

#[derive(Debug, Clone, Args)]
pub struct SetupArgs {
    /// Port to expose the Stonefruit server on
    #[arg(long)]
    pub port: Option<u16>,

    /// Password for the initial server setup
    #[arg(long, conflicts_with = "password_stdin")]
    pub password: Option<String>,

    /// Read the setup password from stdin
    #[arg(long, conflicts_with = "password")]
    pub password_stdin: bool,

    /// Skip the interactive wizard and run setup immediately
    #[arg(long)]
    pub yes: bool,
}

impl SetupArgs {
    pub fn wants_non_interactive(&self) -> bool {
        self.yes || self.port.is_some() || self.password.is_some() || self.password_stdin
    }
}

#[derive(Debug, Clone, Args)]
pub struct StatusArgs {
    /// Base URL of the Stonefruit server
    #[arg(long, default_value = "http://localhost:3005")]
    pub base_url: String,

    /// Emit raw JSON
    #[arg(long)]
    pub json: bool,
}

pub const fn version() -> &'static str {
    match option_env!("STONEFRUIT_VERSION") {
        Some(version) => version,
        None => env!("CARGO_PKG_VERSION"),
    }
}
