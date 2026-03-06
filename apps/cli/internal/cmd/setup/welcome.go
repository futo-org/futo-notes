package setup

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"gitlab.futo.org/stonefruit/stonefruit/cli/internal/style"
)

var banner = `     _                    __            _ _
    | |                  / _|          (_) |
 ___| |_ ___  _ __   ___| |_ _ __ _   _ _| |_
/ __| __/ _ \| '_ \ / _ \  _| '__| | | | | __|
\__ \ || (_) | | | |  __/ | | |  | |_| | | |_
|___/\__\___/|_| |_|\___|_| |_|   \__,_|_|\__|`

type welcomeModel struct{}

func newWelcomeModel() welcomeModel {
	return welcomeModel{}
}

func (m welcomeModel) Init() tea.Cmd {
	return nil
}

func (m welcomeModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if msg, ok := msg.(tea.KeyMsg); ok {
		switch msg.String() {
		case "enter":
			return m, func() tea.Msg { return advanceMsg{} }
		case "q":
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m welcomeModel) View() tea.View {
	var b strings.Builder

	bannerStyle := lipgloss.NewStyle().Foreground(style.Primary)
	// Render each line individually to prevent Lip Gloss from reflowing
	for _, line := range strings.Split(banner, "\n") {
		b.WriteString(bannerStyle.Render(line))
		b.WriteString("\n")
	}
	b.WriteString("\n\n")

	b.WriteString(style.Subtitle.Render("Let's set up your self-hosted notes server"))
	b.WriteString("\n\n")

	b.WriteString(style.HintKey.Render("Enter"))
	b.WriteString(style.Hint.Render(" to begin  "))
	b.WriteString(style.HintKey.Render("q"))
	b.WriteString(style.Hint.Render(" to quit"))
	b.WriteString("\n")

	return tea.NewView(lipgloss.NewStyle().Padding(2, 4).Render(b.String()))
}
