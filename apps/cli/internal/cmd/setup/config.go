package setup

import (
	"fmt"
	"net"
	"strconv"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"gitlab.futo.org/stonefruit/stonefruit/cli/internal/style"
)

type configField int

const (
	fieldPort configField = iota
	fieldPassword
	fieldConfirm
	fieldCount
)

type configModel struct {
	inputs  []textinput.Model
	focused configField
	err     string
}

func newConfigModel() *configModel {
	inputs := make([]textinput.Model, fieldCount)

	port := textinput.New()
	port.Placeholder = "3005"
	port.CharLimit = 5
	port.Focus()
	inputs[fieldPort] = port

	pass := textinput.New()
	pass.Placeholder = "min 8 characters"
	pass.EchoMode = textinput.EchoPassword
	pass.EchoCharacter = '*'
	inputs[fieldPassword] = pass

	confirm := textinput.New()
	confirm.Placeholder = "re-enter password"
	confirm.EchoMode = textinput.EchoPassword
	confirm.EchoCharacter = '*'
	inputs[fieldConfirm] = confirm

	return &configModel{
		inputs:  inputs,
		focused: fieldPort,
	}
}

func (m *configModel) Init() tea.Cmd {
	return textinput.Blink
}

func (m *configModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "tab", "down", "enter":
			if m.focused == fieldConfirm && msg.String() == "enter" {
				return m, m.submit()
			}
			m.focused++
			if m.focused >= fieldCount {
				m.focused = fieldCount - 1
			}
			return m, m.updateFocus()
		case "shift+tab", "up":
			m.focused--
			if m.focused < 0 {
				m.focused = 0
			}
			return m, m.updateFocus()
		case "esc":
			return m, tea.Quit
		}
	}

	cmd := m.updateInput(msg)
	return m, cmd
}

func (m *configModel) updateFocus() tea.Cmd {
	var cmds []tea.Cmd
	for i := range m.inputs {
		if configField(i) == m.focused {
			cmds = append(cmds, m.inputs[i].Focus())
		} else {
			m.inputs[i].Blur()
		}
	}
	return tea.Batch(cmds...)
}

func (m *configModel) updateInput(msg tea.Msg) tea.Cmd {
	var cmd tea.Cmd
	m.inputs[m.focused], cmd = m.inputs[m.focused].Update(msg)
	return cmd
}

func (m *configModel) submit() tea.Cmd {
	m.err = ""

	// Validate port
	portStr := m.inputs[fieldPort].Value()
	if portStr == "" {
		portStr = "3005"
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		m.err = "Port must be between 1 and 65535"
		return nil
	}

	// Check port availability
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		m.err = fmt.Sprintf("Port %d is already in use", port)
		return nil
	}
	ln.Close()

	// Validate password
	password := m.inputs[fieldPassword].Value()
	if len(password) < 8 {
		m.err = "Password must be at least 8 characters"
		return nil
	}
	if password != m.inputs[fieldConfirm].Value() {
		m.err = "Passwords do not match"
		return nil
	}

	cfg := Config{Port: port, Password: password}
	return func() tea.Msg { return advanceMsg{config: cfg} }
}

func (m *configModel) View() tea.View {
	var b strings.Builder

	b.WriteString(style.Title.Render("Server Configuration"))
	b.WriteString("\n\n")

	labels := []string{"Port", "Password", "Confirm password"}
	for i, label := range labels {
		if configField(i) == m.focused {
			b.WriteString(style.HintKey.Render("> "))
		} else {
			b.WriteString("  ")
		}
		b.WriteString(style.Highlight.Render(label))
		b.WriteString("\n  ")
		b.WriteString(m.inputs[i].View())
		b.WriteString("\n\n")
	}

	if m.err != "" {
		b.WriteString(style.Error.Render("  " + m.err))
		b.WriteString("\n\n")
	}

	b.WriteString(style.HintKey.Render("Enter"))
	b.WriteString(style.Hint.Render(" to submit  "))
	b.WriteString(style.HintKey.Render("Tab"))
	b.WriteString(style.Hint.Render(" next field  "))
	b.WriteString(style.HintKey.Render("Esc"))
	b.WriteString(style.Hint.Render(" to quit"))
	b.WriteString("\n")

	return tea.NewView(lipgloss.NewStyle().Padding(2, 4).Render(b.String()))
}
