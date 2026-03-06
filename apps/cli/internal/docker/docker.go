package docker

import (
	"fmt"
	"os/exec"
	"strings"
)

// CheckDocker verifies Docker is available and returns the server version.
func CheckDocker() (string, error) {
	cmd := exec.Command("docker", "version", "--format", "{{.Server.Version}}")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("docker is not available: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

// ComposePull runs docker compose pull in the given directory.
func ComposePull(dir string) error {
	cmd := exec.Command("docker", "compose", "pull")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("docker compose pull failed: %s: %w", string(out), err)
	}
	return nil
}

// ComposeUp runs docker compose up -d in the given directory.
func ComposeUp(dir string) error {
	cmd := exec.Command("docker", "compose", "up", "-d")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("docker compose up failed: %s: %w", string(out), err)
	}
	return nil
}
