package setup

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"gitlab.futo.org/stonefruit/stonefruit/cli/internal/client"
	"gitlab.futo.org/stonefruit/stonefruit/cli/internal/docker"
	"gitlab.futo.org/stonefruit/stonefruit/cli/internal/style"
)

type deployPhase int

const (
	phasePreview deployPhase = iota
	phasePull
	phaseStart
	phaseHealth
	phaseSetup
	phaseDone
)

type deployModel struct {
	config    Config
	phase     deployPhase
	spinner   spinner.Model
	compose   string
	workDir   string
	phases    []phaseState
	err       error
}

type phaseState struct {
	label    string
	status   string // "", "running", "done", "failed"
}

type deployStepDoneMsg struct {
	phase deployPhase
	err   error
}

func newDeployModel(cfg Config) *deployModel {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(style.Primary)

	compose := docker.GenerateCompose(cfg.Port)

	return &deployModel{
		config:  cfg,
		phase:   phasePreview,
		spinner: s,
		compose: compose,
		phases: []phaseState{
			{label: "Pulling image"},
			{label: "Starting container"},
			{label: "Waiting for server"},
			{label: "Setting password"},
		},
	}
}

func (m *deployModel) Init() tea.Cmd {
	return m.spinner.Tick
}

func (m *deployModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "enter":
			if m.phase == phasePreview {
				return m, m.startDeploy()
			}
			if m.phase == phaseDone && m.err == nil {
				return m, func() tea.Msg {
					return advanceMsg{config: m.config}
				}
			}
		case "esc":
			if m.phase == phasePreview {
				return m, tea.Quit
			}
		case "r":
			if m.err != nil {
				m.err = nil
				return m, m.runPhase(m.phase)
			}
		}
	case deployStepDoneMsg:
		idx := int(msg.phase) - int(phasePull)
		if idx >= 0 && idx < len(m.phases) {
			if msg.err != nil {
				m.phases[idx].status = "failed"
				m.err = msg.err
				return m, nil
			}
			m.phases[idx].status = "done"
		}
		next := msg.phase + 1
		if next > phaseSetup {
			m.phase = phaseDone
			return m, nil
		}
		m.phase = next
		return m, m.runPhase(next)
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m *deployModel) startDeploy() tea.Cmd {
	// Write compose file to current working directory
	dir, err := os.Getwd()
	if err != nil {
		m.err = fmt.Errorf("failed to get working directory: %w", err)
		return nil
	}
	m.workDir = dir
	composePath := filepath.Join(dir, "docker-compose.yml")
	if err := os.WriteFile(composePath, []byte(m.compose), 0644); err != nil {
		m.err = fmt.Errorf("failed to write compose file: %w", err)
		return nil
	}

	m.phase = phasePull
	m.phases[0].status = "running"
	return m.runPhase(phasePull)
}

func (m *deployModel) runPhase(phase deployPhase) tea.Cmd {
	idx := int(phase) - int(phasePull)
	if idx >= 0 && idx < len(m.phases) {
		m.phases[idx].status = "running"
	}

	switch phase {
	case phasePull:
		return func() tea.Msg {
			err := docker.ComposePull(m.workDir)
			return deployStepDoneMsg{phase: phasePull, err: err}
		}
	case phaseStart:
		return func() tea.Msg {
			err := docker.ComposeUp(m.workDir)
			return deployStepDoneMsg{phase: phaseStart, err: err}
		}
	case phaseHealth:
		baseURL := fmt.Sprintf("http://localhost:%d", m.config.Port)
		return func() tea.Msg {
			deadline := time.Now().Add(30 * time.Second)
			for time.Now().Before(deadline) {
				_, err := client.CheckHealth(baseURL)
				if err == nil {
					return deployStepDoneMsg{phase: phaseHealth}
				}
				time.Sleep(time.Second)
			}
			return deployStepDoneMsg{
				phase: phaseHealth,
				err:   fmt.Errorf("server did not become healthy within 30s"),
			}
		}
	case phaseSetup:
		baseURL := fmt.Sprintf("http://localhost:%d", m.config.Port)
		return func() tea.Msg {
			err := client.Setup(baseURL, m.config.Password)
			return deployStepDoneMsg{phase: phaseSetup, err: err}
		}
	}
	return nil
}

func (m *deployModel) View() tea.View {
	var b strings.Builder

	b.WriteString(style.Title.Render("Deploy"))
	b.WriteString("\n\n")

	if m.phase == phasePreview {
		b.WriteString(style.Subtitle.Render("docker-compose.yml"))
		b.WriteString("\n")
		b.WriteString(style.Box.Render(m.compose))
		b.WriteString("\n\n")
		b.WriteString(style.HintKey.Render("Enter"))
		b.WriteString(style.Hint.Render(" to deploy  "))
		b.WriteString(style.HintKey.Render("Esc"))
		b.WriteString(style.Hint.Render(" to cancel"))
		b.WriteString("\n")
		return tea.NewView(lipgloss.NewStyle().Padding(2, 4).Render(b.String()))
	}

	for _, p := range m.phases {
		var icon string
		switch p.status {
		case "running":
			icon = m.spinner.View()
		case "done":
			icon = style.SuccessStyle.Render("\u2713")
		case "failed":
			icon = style.Error.Render("\u2717")
		default:
			icon = style.Hint.Render("-")
		}
		b.WriteString(fmt.Sprintf("  %s %s\n", icon, p.label))
	}

	if m.err != nil {
		b.WriteString("\n")
		b.WriteString(style.Error.Render(fmt.Sprintf("  Error: %v", m.err)))
		b.WriteString("\n\n")
		b.WriteString(style.HintKey.Render("r"))
		b.WriteString(style.Hint.Render(" to retry  "))
		b.WriteString(style.HintKey.Render("ctrl+c"))
		b.WriteString(style.Hint.Render(" to quit"))
	} else if m.phase == phaseDone {
		b.WriteString("\n")
		b.WriteString(style.HintKey.Render("Enter"))
		b.WriteString(style.Hint.Render(" to continue"))
	}

	b.WriteString("\n")
	return tea.NewView(lipgloss.NewStyle().Padding(2, 4).Render(b.String()))
}
