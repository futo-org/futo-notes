package docker

import "fmt"

// GenerateCompose returns a docker-compose.yml for the Stonefruit server.
func GenerateCompose(port int) string {
	return fmt.Sprintf(`services:
  server:
    container_name: stonefruit
    image: gitlab.futo.org:5050/stonefruit/stonefruit/server:latest
    ports:
      - "%d:%d"
    volumes:
      - data:/app/apps/server/data
    environment:
      - PORT=%d
      - DATABASE_PATH=./data/stonefruit.db
      - NOTES_PATH=./data/notes
    restart: unless-stopped

volumes:
  data:
`, port, port, port)
}
