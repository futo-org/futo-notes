package style

import "charm.land/lipgloss/v2"

// Warm Parchment theme colors.
var (
	Primary = lipgloss.Color("#B07D3B")
	Text    = lipgloss.Color("#1C1917")
	Muted   = lipgloss.Color("#78716C")
	Border  = lipgloss.Color("#DDD8D0")
	Surface = lipgloss.Color("#F0ECE6")
	Bg      = lipgloss.Color("#FAF9F6")
	Danger  = lipgloss.Color("#B8442A")
	Success = lipgloss.Color("#3D7A3F")
)

// Reusable styles.
var (
	Title = lipgloss.NewStyle().
		Bold(true).
		Foreground(Primary)

	Subtitle = lipgloss.NewStyle().
			Foreground(Muted)

	Error = lipgloss.NewStyle().
		Foreground(Danger)

	SuccessStyle = lipgloss.NewStyle().
			Foreground(Success)

	Highlight = lipgloss.NewStyle().
			Bold(true).
			Foreground(Text)

	Box = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(Border).
		Padding(1, 2)

	HintKey = lipgloss.NewStyle().
		Bold(true).
		Foreground(Primary)

	Hint = lipgloss.NewStyle().
		Foreground(Muted)
)
