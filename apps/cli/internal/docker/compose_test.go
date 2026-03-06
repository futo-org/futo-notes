package docker

import (
	"strings"
	"testing"
)

func TestGenerateCompose(t *testing.T) {
	t.Run("default port", func(t *testing.T) {
		out := GenerateCompose(3005)
		if !strings.Contains(out, "3005:3005") {
			t.Errorf("expected port mapping 3005:3005, got:\n%s", out)
		}
		if !strings.Contains(out, "PORT=3005") {
			t.Errorf("expected PORT=3005 in environment, got:\n%s", out)
		}
	})

	t.Run("custom port", func(t *testing.T) {
		out := GenerateCompose(8080)
		if !strings.Contains(out, "8080:8080") {
			t.Errorf("expected port mapping 8080:8080, got:\n%s", out)
		}
		if !strings.Contains(out, "PORT=8080") {
			t.Errorf("expected PORT=8080 in environment, got:\n%s", out)
		}
	})

	t.Run("has required fields", func(t *testing.T) {
		out := GenerateCompose(3005)
		required := []string{
			"services:",
			"container_name: stonefruit",
			"image: gitlab.futo.org:5050/stonefruit/stonefruit/server:latest",
			"volumes:",
			"data:/app/apps/server/data",
			"DATABASE_PATH=./data/stonefruit.db",
			"NOTES_PATH=./data/notes",
			"restart: unless-stopped",
		}
		for _, req := range required {
			if !strings.Contains(out, req) {
				t.Errorf("expected %q in output, got:\n%s", req, out)
			}
		}
	})
}
