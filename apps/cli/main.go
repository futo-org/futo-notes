package main

import (
	"fmt"
	"os"

	"gitlab.futo.org/stonefruit/stonefruit/cli/internal/cmd/setup"
)

var version = "dev"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(0)
	}

	switch os.Args[1] {
	case "setup":
		if err := setup.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	case "status":
		fmt.Println("coming soon")
	case "help", "--help", "-h":
		printUsage()
	case "version", "--version", "-v":
		fmt.Printf("stonefruit %s\n", version)
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Printf(`stonefruit %s — self-hosted notes server CLI

Usage:
  stonefruit <command>

Commands:
  setup     Run the setup wizard to deploy a Stonefruit server
  status    Show server status (coming soon)
  version   Print version
  help      Show this message
`, version)
}
