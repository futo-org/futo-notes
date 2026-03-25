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
    /// Reset the server password via admin token (no data loss)
    ResetPassword(ResetPasswordArgs),
    /// Pull the latest server image and restart
    Update(UpdateArgs),
    /// Print version
    Version,
}

#[derive(Debug, Clone, Args)]
pub struct SetupArgs {
    /// Port to expose the Stonefruit server on
    #[arg(long)]
    pub port: Option<u16>,

    /// Host directory to store Stonefruit notes and server data
    #[arg(long)]
    pub data_path: Option<String>,

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
        self.yes
            || self.port.is_some()
            || self.data_path.is_some()
            || self.password.is_some()
            || self.password_stdin
    }
}

#[derive(Debug, Clone, Args)]
pub struct StatusArgs {
    /// Base URL of the Stonefruit server
    #[arg(long, default_value = "http://localhost:3005")]
    pub base_url: String,

    /// Server password (to fetch authenticated dashboard status)
    #[arg(long, conflicts_with = "password_stdin")]
    pub password: Option<String>,

    /// Read the password from stdin
    #[arg(long, conflicts_with = "password")]
    pub password_stdin: bool,

    /// Emit raw JSON
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct ResetPasswordArgs {
    /// Base URL of the Stonefruit server
    #[arg(long, default_value = "http://localhost:3005")]
    pub base_url: String,

    /// Host directory where Stonefruit data is stored (reads .admin-token)
    #[arg(long, default_value = "./stonefruit-data")]
    pub data_path: String,

    /// New password to set
    #[arg(long, conflicts_with = "password_stdin")]
    pub password: Option<String>,

    /// Read the new password from stdin
    #[arg(long, conflicts_with = "password")]
    pub password_stdin: bool,
}

#[derive(Debug, Clone, Args)]
pub struct UpdateArgs {
    /// Directory containing docker-compose.yml (default: current directory)
    #[arg(long)]
    pub compose_dir: Option<String>,
}

pub const fn version() -> &'static str {
    match option_env!("STONEFRUIT_VERSION") {
        Some(version) => version,
        None => env!("CARGO_PKG_VERSION"),
    }
}

#[cfg(test)]
mod tests {
    use super::SetupArgs;

    #[test]
    fn data_path_enables_non_interactive_mode() {
        let args = SetupArgs {
            port: None,
            data_path: Some("/srv/stonefruit-data".to_string()),
            password: None,
            password_stdin: false,
            yes: false,
        };

        assert!(args.wants_non_interactive());
    }
}
