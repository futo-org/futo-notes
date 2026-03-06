package client

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCheckHealth(t *testing.T) {
	t.Run("healthy with setup complete", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/health" {
				t.Errorf("unexpected path: %s", r.URL.Path)
			}
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]any{
				"status":         "ok",
				"setup_complete": true,
			})
		}))
		defer srv.Close()

		complete, err := CheckHealth(srv.URL)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !complete {
			t.Error("expected setup_complete to be true")
		}
	})

	t.Run("healthy without setup", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]any{
				"status":         "ok",
				"setup_complete": false,
			})
		}))
		defer srv.Close()

		complete, err := CheckHealth(srv.URL)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if complete {
			t.Error("expected setup_complete to be false")
		}
	})

	t.Run("server error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer srv.Close()

		_, err := CheckHealth(srv.URL)
		if err == nil {
			t.Error("expected error for 500 status")
		}
	})

	t.Run("unreachable server", func(t *testing.T) {
		_, err := CheckHealth("http://127.0.0.1:1")
		if err == nil {
			t.Error("expected error for unreachable server")
		}
	})
}

func TestSetup(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/setup" {
				t.Errorf("unexpected path: %s", r.URL.Path)
			}
			if r.Method != http.MethodPost {
				t.Errorf("unexpected method: %s", r.Method)
			}
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["password"] != "testpass123" {
				t.Errorf("unexpected password: %s", body["password"])
			}
			w.WriteHeader(http.StatusCreated)
		}))
		defer srv.Close()

		err := Setup(srv.URL, "testpass123")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("already configured", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusConflict)
		}))
		defer srv.Close()

		err := Setup(srv.URL, "testpass123")
		if err == nil {
			t.Error("expected error for 409")
		}
	})

	t.Run("server error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer srv.Close()

		err := Setup(srv.URL, "testpass123")
		if err == nil {
			t.Error("expected error for 500")
		}
	})
}
