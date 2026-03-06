package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

var httpClient = &http.Client{Timeout: 5 * time.Second}

type healthResponse struct {
	Status        string `json:"status"`
	SetupComplete bool   `json:"setup_complete"`
}

// CheckHealth calls GET /health and returns whether setup is complete.
func CheckHealth(baseURL string) (bool, error) {
	resp, err := httpClient.Get(baseURL + "/health")
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("health check returned status %d", resp.StatusCode)
	}

	var h healthResponse
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil {
		return false, fmt.Errorf("invalid health response: %w", err)
	}
	return h.SetupComplete, nil
}

// Setup calls POST /setup with the given password.
func Setup(baseURL, password string) error {
	body, _ := json.Marshal(map[string]string{"password": password})
	resp, err := httpClient.Post(baseURL+"/setup", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("setup request failed: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusCreated:
		return nil
	case http.StatusConflict:
		return fmt.Errorf("server is already configured")
	default:
		return fmt.Errorf("setup returned status %d", resp.StatusCode)
	}
}
