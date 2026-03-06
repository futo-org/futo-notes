package setup

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"gitlab.futo.org/stonefruit/stonefruit/cli/internal/style"
)

type successModel struct {
	config Config
}

func newSuccessModel(cfg Config) *successModel {
	return &successModel{config: cfg}
}

func (m *successModel) Init() tea.Cmd {
	return nil
}

func (m *successModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if msg, ok := msg.(tea.KeyMsg); ok {
		switch msg.String() {
		case "q", "enter":
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m *successModel) View() tea.View {
	var b strings.Builder

	b.WriteString(style.SuccessStyle.Render("\u2713 Stonefruit server is running!"))
	b.WriteString("\n\n")

	serverURL := fmt.Sprintf("http://localhost:%d", m.config.Port)
	b.WriteString(fmt.Sprintf("  %s  %s", style.Highlight.Render("Server:"), serverURL))
	b.WriteString("\n\n")

	b.WriteString(style.Subtitle.Render("  Next steps:"))
	b.WriteString("\n")
	b.WriteString(style.Hint.Render("  1. Open Stonefruit on your phone or computer"))
	b.WriteString("\n")
	b.WriteString(style.Hint.Render("  2. Go to Settings > Sync"))
	b.WriteString("\n")
	b.WriteString(style.Hint.Render("  3. Enter the server URL and your password"))
	b.WriteString("\n\n")

	b.WriteString(style.Hint.Render("  For HTTPS, see: https://stonefruit.futo.org/docs/remote-access"))
	b.WriteString("\n\n")

	b.WriteString(style.HintKey.Render("q"))
	b.WriteString(style.Hint.Render(" to exit"))
	b.WriteString("\n")

	return tea.NewView(lipgloss.NewStyle().Padding(2, 4).Render(b.String()))
}
