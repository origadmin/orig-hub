package core

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

type APIServer struct {
	service DownloadService
	token   string
	mux     *http.ServeMux
}

func NewAPIServer(service DownloadService, token string) *APIServer {
	s := &APIServer{
		service: service,
		token:   token,
		mux:     http.NewServeMux(),
	}
	s.registerRoutes()
	return s
}

func (s *APIServer) registerRoutes() {
	s.mux.HandleFunc("/health", s.handleHealth)
	s.mux.HandleFunc("/api/downloads", s.handleDownloads)
	s.mux.HandleFunc("/api/downloads/", s.handleDownloadByID)
}

func (s *APIServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.token != "" {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") || strings.TrimPrefix(auth, "Bearer ") != s.token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}
	s.mux.ServeHTTP(w, r)
}

func (s *APIServer) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *APIServer) handleDownloads(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		statuses, err := s.service.List()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, statuses)
	case http.MethodPost:
		var req struct {
			URL        string            `json:"url"`
			OutputPath string            `json:"output_path"`
			Filename   string            `json:"filename"`
			Mirrors    []string          `json:"mirrors"`
			Headers    map[string]string `json:"headers"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if req.URL == "" {
			http.Error(w, "url is required", http.StatusBadRequest)
			return
		}
		id, err := s.service.Add(context.Background(), req.URL, req.OutputPath, req.Filename, req.Mirrors, req.Headers)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]string{"id": id})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *APIServer) handleDownloadByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/downloads/")
	if id == "" {
		http.Error(w, "id is required", http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodGet:
		status, err := s.service.GetStatus(id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, status)
	case http.MethodPost:
		action := r.URL.Query().Get("action")
		switch action {
		case "pause":
			if err := s.service.Pause(id); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "paused", "id": id})
		case "resume":
			if err := s.service.Resume(context.Background(), id); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "resumed", "id": id})
		case "cancel":
			if err := s.service.Cancel(id); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "cancelled", "id": id})
		default:
			http.Error(w, "unknown action", http.StatusBadRequest)
		}
	case http.MethodDelete:
		if err := s.service.Remove(id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted", "id": id})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		http.Error(w, "failed to encode response", http.StatusInternalServerError)
	}
}
