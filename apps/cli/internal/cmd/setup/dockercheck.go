package setup

import (
	"fmt"
	"strings"
	"time"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"gitlab.futo.org/stonefruit/stonefruit/cli/internal/docker"
	"gitlab.futo.org/stonefruit/stonefruit/cli/internal/style"
)

type dockerCheckModel struct {
	spinner  spinner.Model
	checking bool
	version  string
	err      error
	done     bool
}

type dockerCheckDoneMsg struct {
	version string
	err     error
}

type autoAdvanceMsg struct{}

func newDockerCheckModel() *dockerCheckModel {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(style.Primary)
	return &dockerCheckModel{
		spinner:  s,
		checking: true,
	}
}

func (m *dockerCheckModel) Init() tea.Cmd {
	return tea.Batch(m.spinner.Tick, checkDockerCmd)
}

func checkDockerCmd() tea.Msg {
	version, err := docker.CheckDocker()
	return dockerCheckDoneMsg{version: version, err: err}
}

func (m *dockerCheckModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case dockerCheckDoneMsg:
		m.checking = false
		m.version = msg.version
		m.err = msg.err
		m.done = true
		if msg.err == nil {
			return m, tea.Tick(time.Second, func(time.Time) tea.Msg {
				return autoAdvanceMsg{}
			})
		}
		return m, nil
	case autoAdvanceMsg:
		return m, func() tea.Msg { return advanceMsg{} }
	case tea.KeyMsg:
		if m.done && m.err != nil {
			if msg.String() == "q" || msg.String() == "enter" {
				return m, tea.Quit
			}
		}
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m *dockerCheckModel) View() tea.View {
	var b strings.Builder

	b.WriteString(style.Title.Render("Checking Docker"))
	b.WriteString("\n\n")

	if m.checking {
		b.WriteString(m.spinner.View())
		b.WriteString(" Detecting Docker...")
	} else if m.err != nil {
		b.WriteString(style.Error.Render("\u2717 Docker not found"))
		b.WriteString("\n\n")
		b.WriteString(style.Hint.Render(fmt.Sprintf("  Error: %v", m.err)))
		b.WriteString("\n\n")
		b.WriteString(style.Hint.Render("  Install Docker: https://docs.docker.com/get-docker/"))
		b.WriteString("\n\n")
		b.WriteString(style.HintKey.Render("q"))
		b.WriteString(style.Hint.Render(" to quit"))
	} else {
		b.WriteString(style.SuccessStyle.Render(fmt.Sprintf("\u2713 Docker %s detected", m.version)))
	}

	b.WriteString("\n")
	return tea.NewView(lipgloss.NewStyle().Padding(2, 4).Render(b.String()))
}
