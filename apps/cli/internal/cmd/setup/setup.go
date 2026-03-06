package setup

import (
	"fmt"

	tea "charm.land/bubbletea/v2"
)

type screen int

const (
	screenWelcome screen = iota
	screenDockerCheck
	screenConfig
	screenDeploy
	screenSuccess
)

// Config holds user-provided setup values passed between screens.
type Config struct {
	Port     int
	Password string
}

// model is the top-level orchestrator that sequences through screens.
type model struct {
	screen  screen
	config  Config
	current tea.Model
	quitting bool
}

func initialModel() model {
	return model{
		screen:  screenWelcome,
		current: newWelcomeModel(),
	}
}

func (m model) Init() tea.Cmd {
	return m.current.Init()
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			m.quitting = true
			return m, tea.Quit
		}
	case advanceMsg:
		return m.advance(msg)
	}

	var cmd tea.Cmd
	m.current, cmd = m.current.Update(msg)
	return m, cmd
}

func (m model) View() tea.View {
	if m.quitting {
		return tea.NewView("")
	}
	v := m.current.View()
	v.AltScreen = true
	return v
}

// advanceMsg signals the orchestrator to move to the next screen.
type advanceMsg struct {
	config Config
}

func (m model) advance(msg advanceMsg) (tea.Model, tea.Cmd) {
	m.config = msg.config

	switch m.screen {
	case screenWelcome:
		m.screen = screenDockerCheck
		m.current = newDockerCheckModel()
	case screenDockerCheck:
		m.screen = screenConfig
		m.current = newConfigModel()
	case screenConfig:
		m.screen = screenDeploy
		m.current = newDeployModel(m.config)
	case screenDeploy:
		m.screen = screenSuccess
		m.current = newSuccessModel(m.config)
	case screenSuccess:
		return m, tea.Quit
	}

	return m, m.current.Init()
}

// Run starts the setup wizard TUI.
func Run() error {
	p := tea.NewProgram(initialModel())
	finalModel, err := p.Run()
	if err != nil {
		return fmt.Errorf("TUI error: %w", err)
	}
	if m, ok := finalModel.(model); ok && m.quitting {
		return nil
	}
	return nil
}
