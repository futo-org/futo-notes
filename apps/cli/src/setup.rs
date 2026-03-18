use crate::cli::SetupArgs;
use crate::docker::{self, DEFAULT_DATA_PATH, DEFAULT_PORT};
use crate::server_api;
use anyhow::{anyhow, bail, Context, Result};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::{Frame, Terminal};
use std::fs;
use std::io::{self, Read};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

const BANNER: &[&str] = &[
    "     _                    __            _ _",
    "    | |                  / _|          (_) |",
    " ___| |_ ___  _ __   ___| |_ _ __ _   _ _| |_",
    "/ __| __/ _ \\| '_ \\ / _ \\  _| '__| | | | | __|",
    "\\__ \\ || (_) | | | |  __/ | | |  | |_| | | |_",
    "|___/\\__\\___/|_| |_|\\___|_| |_|   \\__,_|_|\\__|",
];

pub fn run(args: SetupArgs) -> Result<()> {
    if args.wants_non_interactive() {
        return run_non_interactive(args);
    }

    run_interactive()
}

fn run_non_interactive(args: SetupArgs) -> Result<()> {
    if !args.yes {
        bail!("use --yes to run setup non-interactively");
    }

    let port = args.port.unwrap_or(DEFAULT_PORT);
    let data_path = args
        .data_path
        .clone()
        .unwrap_or_else(|| DEFAULT_DATA_PATH.to_string());
    let password = read_password(&args)?;
    let config = Config {
        port,
        data_path,
        password,
    };
    validate_config(&config)?;

    let version = docker::check_docker()?;
    println!("Docker {} detected", version);

    let work_dir = std::env::current_dir().context("failed to get working directory")?;
    write_compose_file(&work_dir, &config)?;
    println!("Wrote docker-compose.yml to {}", work_dir.display());

    println!("Pulling image...");
    docker::compose_pull(&work_dir)?;
    println!("Starting container...");
    docker::compose_up(&work_dir)?;
    println!("Waiting for server...");
    wait_for_server(config.port)?;
    println!("Setting password...");
    server_api::setup(&base_url(config.port), &config.password)?;

    print_success(&config);
    Ok(())
}

fn run_interactive() -> Result<()> {
    let mut terminal = init_terminal()?;
    let result = App::default().run(&mut terminal);
    restore_terminal(&mut terminal)?;
    result
}

fn init_terminal() -> Result<Terminal<CrosstermBackend<io::Stdout>>> {
    enable_raw_mode().context("failed to enable raw mode")?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen).context("failed to enter alternate screen")?;
    let backend = CrosstermBackend::new(stdout);
    Terminal::new(backend).context("failed to initialize terminal")
}

fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
    disable_raw_mode().context("failed to disable raw mode")?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)
        .context("failed to leave alternate screen")?;
    terminal
        .show_cursor()
        .context("failed to show terminal cursor")?;
    Ok(())
}

#[derive(Debug, Clone)]
struct Config {
    port: u16,
    data_path: String,
    password: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Screen {
    Welcome,
    DockerCheck,
    Config,
    DeployPreview,
    DeployRunning,
    Success,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Pull,
    Start,
    Health,
    Setup,
}

impl Phase {
    fn all() -> [Phase; 4] {
        [Phase::Pull, Phase::Start, Phase::Health, Phase::Setup]
    }

    fn label(self) -> &'static str {
        match self {
            Phase::Pull => "Pulling image",
            Phase::Start => "Starting container",
            Phase::Health => "Waiting for server",
            Phase::Setup => "Setting password",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PhaseStatus {
    Pending,
    Running,
    Done,
    Failed,
}

#[derive(Debug)]
enum WorkerEvent {
    DockerCheckOk(String),
    DockerCheckErr(String),
    PhaseStarted(Phase),
    PhaseFinished(Phase),
    DeployFinished,
    DeployFailed(Phase, String),
}

struct App {
    screen: Screen,
    focused: usize,
    inputs: [InputField; 4],
    error: Option<String>,
    compose_preview: String,
    deployment_error: Option<String>,
    phase_statuses: [(Phase, PhaseStatus); 4],
    phase_index: usize,
    work_dir: Option<PathBuf>,
    config: Option<Config>,
    should_quit: bool,
    spinner_index: usize,
    last_tick: Instant,
    tx: Sender<WorkerEvent>,
    rx: Receiver<WorkerEvent>,
}

impl Default for App {
    fn default() -> Self {
        let (tx, rx) = mpsc::channel();
        Self {
            screen: Screen::Welcome,
            focused: 0,
            inputs: [
                InputField::new("Port", DEFAULT_PORT.to_string(), false),
                InputField::new(
                    "Notes storage directory",
                    DEFAULT_DATA_PATH.to_string(),
                    false,
                ),
                InputField::new("Password", String::new(), true),
                InputField::new("Confirm password", String::new(), true),
            ],
            error: None,
            compose_preview: String::new(),
            deployment_error: None,
            phase_statuses: [
                (Phase::Pull, PhaseStatus::Pending),
                (Phase::Start, PhaseStatus::Pending),
                (Phase::Health, PhaseStatus::Pending),
                (Phase::Setup, PhaseStatus::Pending),
            ],
            phase_index: 0,
            work_dir: None,
            config: None,
            should_quit: false,
            spinner_index: 0,
            last_tick: Instant::now(),
            tx,
            rx,
        }
    }
}

impl App {
    fn run(&mut self, terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
        loop {
            while let Ok(event) = self.rx.try_recv() {
                self.handle_worker_event(event)?;
            }

            terminal.draw(|frame| self.render(frame))?;

            if self.should_quit {
                return Ok(());
            }

            if event::poll(Duration::from_millis(100)).context("failed to read terminal event")? {
                if let Event::Key(key) = event::read().context("failed to read key event")? {
                    self.handle_key(key)?;
                }
            }

            if self.last_tick.elapsed() >= Duration::from_millis(120) {
                self.spinner_index = (self.spinner_index + 1) % SPINNER_FRAMES.len();
                self.last_tick = Instant::now();
            }
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> Result<()> {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.should_quit = true;
            return Ok(());
        }

        match self.screen {
            Screen::Welcome => match key.code {
                KeyCode::Enter => self.start_docker_check(),
                KeyCode::Char('q') => self.should_quit = true,
                _ => {}
            },
            Screen::DockerCheck => match key.code {
                KeyCode::Char('q') | KeyCode::Esc if self.error.is_some() => {
                    self.should_quit = true
                }
                KeyCode::Char('r') if self.error.is_some() => self.start_docker_check(),
                _ => {}
            },
            Screen::Config => self.handle_config_key(key)?,
            Screen::DeployPreview => match key.code {
                KeyCode::Enter => self.start_deploy()?,
                KeyCode::Esc => self.should_quit = true,
                _ => {}
            },
            Screen::DeployRunning => match key.code {
                KeyCode::Char('r') if self.deployment_error.is_some() => self.retry_deploy(),
                _ => {}
            },
            Screen::Success => match key.code {
                KeyCode::Enter | KeyCode::Char('q') => self.should_quit = true,
                _ => {}
            },
        }

        Ok(())
    }

    fn handle_config_key(&mut self, key: KeyEvent) -> Result<()> {
        match key.code {
            KeyCode::Tab | KeyCode::Down => {
                self.focused = (self.focused + 1).min(self.inputs.len() - 1);
            }
            KeyCode::BackTab | KeyCode::Up => {
                self.focused = self.focused.saturating_sub(1);
            }
            KeyCode::Enter => {
                if self.focused == self.inputs.len() - 1 {
                    self.submit_config()?;
                } else {
                    self.focused += 1;
                }
            }
            KeyCode::Esc => self.should_quit = true,
            _ => self.inputs[self.focused].handle_key(key),
        }

        Ok(())
    }

    fn handle_worker_event(&mut self, event: WorkerEvent) -> Result<()> {
        match event {
            WorkerEvent::DockerCheckOk(_version) => {
                self.error = None;
                self.screen = Screen::Config;
            }
            WorkerEvent::DockerCheckErr(error) => {
                self.error = Some(error);
            }
            WorkerEvent::PhaseStarted(phase) => {
                self.set_phase_status(phase, PhaseStatus::Running);
                self.deployment_error = None;
            }
            WorkerEvent::PhaseFinished(phase) => {
                self.set_phase_status(phase, PhaseStatus::Done);
                self.phase_index = phase_index(phase) + 1;
            }
            WorkerEvent::DeployFinished => {
                self.screen = Screen::Success;
            }
            WorkerEvent::DeployFailed(phase, error) => {
                self.set_phase_status(phase, PhaseStatus::Failed);
                self.phase_index = phase_index(phase);
                self.deployment_error = Some(error);
            }
        }

        Ok(())
    }

    fn render(&self, frame: &mut Frame) {
        let area = centered(frame.area(), 92, 88);
        frame.render_widget(Clear, area);
        match self.screen {
            Screen::Welcome => self.render_welcome(frame, area),
            Screen::DockerCheck => self.render_docker_check(frame, area),
            Screen::Config => self.render_config(frame, area),
            Screen::DeployPreview => self.render_deploy_preview(frame, area),
            Screen::DeployRunning => self.render_deploy_running(frame, area),
            Screen::Success => self.render_success(frame, area),
        }
    }

    fn render_welcome(&self, frame: &mut Frame, area: Rect) {
        let layout = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length((BANNER.len() + 1) as u16),
                Constraint::Length(3),
                Constraint::Length(2),
                Constraint::Min(1),
            ])
            .split(area);

        let banner = BANNER
            .iter()
            .map(|line| Line::from(Span::styled(*line, Style::default().fg(PRIMARY))))
            .collect::<Vec<_>>();
        frame.render_widget(
            Paragraph::new(Text::from(banner)).alignment(Alignment::Center),
            layout[0],
        );
        frame.render_widget(
            Paragraph::new("Let's set up your server")
                .style(Style::default().fg(Color::White))
                .alignment(Alignment::Center),
            layout[1],
        );
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                key_span("Enter"),
                Span::raw(" to begin  "),
                key_span("q"),
                Span::raw(" to quit"),
            ]))
            .alignment(Alignment::Center),
            layout[2],
        );
    }

    fn render_docker_check(&self, frame: &mut Frame, area: Rect) {
        let block = panel("Checking Docker");
        let inner = block.inner(area);
        frame.render_widget(block, area);

        let text = if let Some(error) = &self.error {
            Text::from(vec![
                Line::from(Span::styled(
                    "Docker not found",
                    Style::default().fg(DANGER),
                )),
                Line::raw(""),
                Line::from(error.as_str()),
                Line::raw(""),
                Line::from("Install Docker: https://docs.docker.com/get-docker/"),
                Line::raw(""),
                Line::from(vec![
                    key_span("r"),
                    Span::raw(" retry  "),
                    key_span("q"),
                    Span::raw(" quit"),
                ]),
            ])
        } else {
            Text::from(vec![Line::from(format!(
                "{} Detecting Docker...",
                spinner_frame(self.spinner_index)
            ))])
        };

        frame.render_widget(Paragraph::new(text).wrap(Wrap { trim: false }), inner);
    }

    fn render_config(&self, frame: &mut Frame, area: Rect) {
        let block = panel("Server Configuration");
        let inner = block.inner(area);
        frame.render_widget(block, area);

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Length(3),
                Constraint::Length(3),
                Constraint::Length(3),
                Constraint::Length(3),
                Constraint::Min(1),
            ])
            .split(inner);

        for (idx, field) in self.inputs.iter().enumerate() {
            let title = if idx == self.focused {
                format!("> {}", field.label)
            } else {
                field.label.clone()
            };
            let widget = Paragraph::new(field.display_value()).block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(if idx == self.focused {
                        Style::default().fg(PRIMARY)
                    } else {
                        Style::default().fg(BORDER)
                    })
                    .title(title),
            );
            frame.render_widget(widget, chunks[idx]);
        }

        let mut footer = vec![
            Line::from(vec![
                key_span("Enter"),
                Span::raw(" submit  "),
                key_span("Tab"),
                Span::raw(" next field  "),
                key_span("Esc"),
                Span::raw(" quit"),
            ]),
        ];

        if let Some(error) = &self.error {
            footer.insert(
                0,
                Line::from(Span::styled(error.as_str(), Style::default().fg(DANGER))),
            );
            footer.insert(1, Line::raw(""));
        }

        frame.render_widget(Paragraph::new(Text::from(footer)), chunks[4]);
    }

    fn render_deploy_preview(&self, frame: &mut Frame, area: Rect) {
        let block = panel("Deploy");
        let inner = block.inner(area);
        frame.render_widget(block, area);

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(8), Constraint::Length(2)])
            .split(inner);

        frame.render_widget(
            Paragraph::new(self.compose_preview.as_str())
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title("docker-compose.yml"),
                )
                .wrap(Wrap { trim: false }),
            chunks[0],
        );
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                key_span("Enter"),
                Span::raw(" deploy  "),
                key_span("Esc"),
                Span::raw(" cancel"),
            ])),
            chunks[1],
        );
    }

    fn render_deploy_running(&self, frame: &mut Frame, area: Rect) {
        let block = panel("Deploy");
        let inner = block.inner(area);
        frame.render_widget(block, area);

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(8), Constraint::Length(4)])
            .split(inner);

        let lines = self
            .phase_statuses
            .iter()
            .map(|(phase, status)| {
                let prefix = match status {
                    PhaseStatus::Pending => Span::styled("- ", Style::default().fg(MUTED)),
                    PhaseStatus::Running => Span::styled(
                        format!("{} ", spinner_frame(self.spinner_index)),
                        Style::default().fg(PRIMARY),
                    ),
                    PhaseStatus::Done => Span::styled("[ok] ", Style::default().fg(SUCCESS)),
                    PhaseStatus::Failed => Span::styled("x ", Style::default().fg(DANGER)),
                };
                Line::from(vec![prefix, Span::raw(phase.label())])
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(Text::from(lines)), chunks[0]);

        let footer = if let Some(error) = &self.deployment_error {
            Text::from(vec![
                Line::from(Span::styled(error.as_str(), Style::default().fg(DANGER))),
                Line::raw(""),
                Line::from(vec![
                    key_span("r"),
                    Span::raw(" retry  "),
                    key_span("Ctrl+C"),
                    Span::raw(" quit"),
                ]),
            ])
        } else {
            Text::from(vec![Line::from("Working...")])
        };
        frame.render_widget(Paragraph::new(footer), chunks[1]);
    }

    fn render_success(&self, frame: &mut Frame, area: Rect) {
        let block = panel("Success");
        let inner = block.inner(area);
        frame.render_widget(block, area);

        let port = self.config.as_ref().map(|c| c.port).unwrap_or(DEFAULT_PORT);
        let url = base_url(port);
        let data_path = self
            .config
            .as_ref()
            .map(|c| c.data_path.as_str())
            .unwrap_or(DEFAULT_DATA_PATH);
        let text = Text::from(vec![
            Line::from(Span::styled(
                "Stonefruit server is running!",
                Style::default().fg(SUCCESS).add_modifier(Modifier::BOLD),
            )),
            Line::raw(""),
            Line::from(format!("Server: {}", url)),
            Line::from(format!("Notes/data: {}", data_path)),
            Line::raw(""),
            Line::from("Next steps:"),
            Line::from("1. Open Stonefruit on your phone or computer"),
            Line::from("2. Go to Settings > Sync"),
            Line::from("3. Enter the server URL and your password"),
            Line::raw(""),
            Line::from("For HTTPS, see: https://stonefruit.futo.org/docs/remote-access"),
            Line::raw(""),
            Line::from(vec![
                key_span("Enter"),
                Span::raw(" exit  "),
                key_span("q"),
                Span::raw(" quit"),
            ]),
        ]);
        frame.render_widget(Paragraph::new(text), inner);
    }

    fn start_docker_check(&mut self) {
        self.screen = Screen::DockerCheck;
        self.error = None;
        let tx = self.tx.clone();
        std::thread::spawn(move || match docker::check_docker() {
            Ok(version) => {
                let _ = tx.send(WorkerEvent::DockerCheckOk(version));
            }
            Err(error) => {
                let _ = tx.send(WorkerEvent::DockerCheckErr(error.to_string()));
            }
        });
    }

    fn submit_config(&mut self) -> Result<()> {
        let config = Config {
            port: self.inputs[0]
                .value
                .parse::<u16>()
                .map_err(|_| anyhow!("port must be between 1 and 65535"))?,
            data_path: self.inputs[1].value.clone(),
            password: self.inputs[2].value.clone(),
        };

        if self.inputs[2].value != self.inputs[3].value {
            self.error = Some("passwords do not match".to_string());
            return Ok(());
        }

        validate_config(&config)?;
        self.error = None;
        self.compose_preview = docker::generate_compose(config.port, &config.data_path);
        self.config = Some(config);
        self.screen = Screen::DeployPreview;
        Ok(())
    }

    fn start_deploy(&mut self) -> Result<()> {
        let work_dir = std::env::current_dir().context("failed to get working directory")?;
        let config = self
            .config
            .clone()
            .ok_or_else(|| anyhow!("missing setup config"))?;
        write_compose_file(&work_dir, &config)?;
        self.work_dir = Some(work_dir.clone());
        self.phase_statuses = [
            (Phase::Pull, PhaseStatus::Pending),
            (Phase::Start, PhaseStatus::Pending),
            (Phase::Health, PhaseStatus::Pending),
            (Phase::Setup, PhaseStatus::Pending),
        ];
        self.phase_index = 0;
        self.deployment_error = None;
        self.screen = Screen::DeployRunning;
        spawn_deploy_worker(self.tx.clone(), work_dir, config, Phase::Pull);
        Ok(())
    }

    fn retry_deploy(&mut self) {
        if let (Some(work_dir), Some(config)) = (self.work_dir.clone(), self.config.clone()) {
            for (phase, status) in &mut self.phase_statuses {
                if phase_index(*phase) >= self.phase_index {
                    *status = PhaseStatus::Pending;
                }
            }
            self.deployment_error = None;
            let phase = Phase::all()[self.phase_index];
            spawn_deploy_worker(self.tx.clone(), work_dir, config, phase);
        }
    }

    fn set_phase_status(&mut self, target: Phase, next_status: PhaseStatus) {
        for (phase, status) in &mut self.phase_statuses {
            if *phase == target {
                *status = next_status;
            }
        }
    }
}

fn write_compose_file(work_dir: &Path, config: &Config) -> Result<()> {
    let compose = docker::generate_compose(config.port, &config.data_path);
    fs::write(work_dir.join("docker-compose.yml"), compose).context("failed to write compose file")
}

fn validate_config(config: &Config) -> Result<()> {
    if config.port == 0 {
        bail!("port must be between 1 and 65535");
    }

    if config.data_path.trim().is_empty() {
        bail!("notes storage directory cannot be empty");
    }

    if config.password.len() < 8 {
        bail!("password must be at least 8 characters");
    }

    let listener = TcpListener::bind(("0.0.0.0", config.port))
        .map_err(|_| anyhow!("port {} is already in use", config.port))?;
    drop(listener);

    Ok(())
}

fn read_password(args: &SetupArgs) -> Result<String> {
    if let Some(password) = &args.password {
        return Ok(password.clone());
    }

    if args.password_stdin {
        let mut buffer = String::new();
        io::stdin()
            .read_to_string(&mut buffer)
            .context("failed to read password from stdin")?;
        return Ok(buffer.trim().to_string());
    }

    bail!("non-interactive setup requires --password or --password-stdin");
}

fn base_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

fn wait_for_server(port: u16) -> Result<()> {
    let base_url = base_url(port);
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if server_api::check_health(&base_url).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(1));
    }

    bail!("server did not become healthy within 30 seconds");
}

fn run_deploy_phase(phase: Phase, work_dir: &Path, config: &Config) -> Result<()> {
    match phase {
        Phase::Pull => docker::compose_pull(work_dir),
        Phase::Start => docker::compose_up(work_dir),
        Phase::Health => wait_for_server(config.port),
        Phase::Setup => server_api::setup(&base_url(config.port), &config.password),
    }
}

fn spawn_deploy_worker(
    tx: Sender<WorkerEvent>,
    work_dir: PathBuf,
    config: Config,
    start_phase: Phase,
) {
    std::thread::spawn(move || {
        for phase in Phase::all().into_iter().skip(phase_index(start_phase)) {
            let _ = tx.send(WorkerEvent::PhaseStarted(phase));
            match run_deploy_phase(phase, &work_dir, &config) {
                Ok(()) => {
                    let _ = tx.send(WorkerEvent::PhaseFinished(phase));
                }
                Err(error) => {
                    let _ = tx.send(WorkerEvent::DeployFailed(phase, error.to_string()));
                    return;
                }
            }
        }
        let _ = tx.send(WorkerEvent::DeployFinished);
    });
}

fn print_success(config: &Config) {
    println!();
    println!("Stonefruit server is running!");
    println!("  Server: {}", base_url(config.port));
    println!("  Notes/data: {}", config.data_path);
    println!();
    println!("Next steps:");
    println!("  1. Open Stonefruit on your phone or computer");
    println!("  2. Go to Settings > Sync");
    println!("  3. Enter the server URL and your password");
    println!();
    println!("For HTTPS, see: https://stonefruit.futo.org/docs/remote-access");
}

fn phase_index(phase: Phase) -> usize {
    match phase {
        Phase::Pull => 0,
        Phase::Start => 1,
        Phase::Health => 2,
        Phase::Setup => 3,
    }
}

fn panel(title: &str) -> Block<'_> {
    Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(BORDER))
}

fn centered(area: Rect, width_percent: u16, height_percent: u16) -> Rect {
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - height_percent) / 2),
            Constraint::Percentage(height_percent),
            Constraint::Percentage((100 - height_percent) / 2),
        ])
        .split(area);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - width_percent) / 2),
            Constraint::Percentage(width_percent),
            Constraint::Percentage((100 - width_percent) / 2),
        ])
        .split(vertical[1])[1]
}

fn key_span(label: &str) -> Span<'static> {
    Span::styled(
        label.to_string(),
        Style::default().fg(PRIMARY).add_modifier(Modifier::BOLD),
    )
}

fn spinner_frame(index: usize) -> &'static str {
    SPINNER_FRAMES[index % SPINNER_FRAMES.len()]
}

const SPINNER_FRAMES: &[&str] = &["-", "\\", "|", "/"];
const PRIMARY: Color = Color::Rgb(176, 125, 59);
const BORDER: Color = Color::Rgb(221, 216, 208);
const MUTED: Color = Color::Rgb(120, 113, 108);
const SUCCESS: Color = Color::Rgb(61, 122, 63);
const DANGER: Color = Color::Rgb(184, 68, 42);

#[derive(Debug, Clone)]
struct InputField {
    label: String,
    value: String,
    cursor: usize,
    hidden: bool,
}

impl InputField {
    fn new(label: impl Into<String>, value: String, hidden: bool) -> Self {
        let cursor = value.chars().count();
        Self {
            label: label.into(),
            value,
            cursor,
            hidden,
        }
    }

    fn display_value(&self) -> String {
        if self.hidden {
            "*".repeat(self.value.chars().count())
        } else {
            self.value.clone()
        }
    }

    fn handle_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                let byte_index = char_to_byte_index(&self.value, self.cursor);
                self.value.insert(byte_index, c);
                self.cursor += 1;
            }
            KeyCode::Backspace => {
                if self.cursor > 0 {
                    self.cursor -= 1;
                    let byte_index = char_to_byte_index(&self.value, self.cursor);
                    self.value.remove(byte_index);
                }
            }
            KeyCode::Delete => {
                if self.cursor < self.value.chars().count() {
                    let byte_index = char_to_byte_index(&self.value, self.cursor);
                    self.value.remove(byte_index);
                }
            }
            KeyCode::Left => {
                self.cursor = self.cursor.saturating_sub(1);
            }
            KeyCode::Right => {
                self.cursor = (self.cursor + 1).min(self.value.chars().count());
            }
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.value.chars().count(),
            _ => {}
        }
    }
}

fn char_to_byte_index(value: &str, char_index: usize) -> usize {
    value
        .char_indices()
        .nth(char_index)
        .map(|(idx, _)| idx)
        .unwrap_or_else(|| value.len())
}

#[cfg(test)]
mod tests {
    use super::{read_password, validate_config, Config};
    use crate::cli::SetupArgs;
    use crate::docker::DEFAULT_DATA_PATH;

    #[test]
    fn validate_requires_password_length() {
        let config = Config {
            port: 3005,
            data_path: DEFAULT_DATA_PATH.to_string(),
            password: "short".to_string(),
        };
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn validate_requires_data_path() {
        let config = Config {
            port: 3005,
            data_path: "   ".to_string(),
            password: "abcdefgh".to_string(),
        };
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn read_password_uses_flag_value() {
        let args = SetupArgs {
            port: None,
            data_path: None,
            password: Some("abcdefgh".to_string()),
            password_stdin: false,
            yes: true,
        };
        assert_eq!(read_password(&args).unwrap(), "abcdefgh");
    }
}
