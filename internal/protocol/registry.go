package protocol

import (
	"fmt"
	"strings"
	"sync"
)

type ProtocolRegistry struct {
	mu        sync.RWMutex
	protocols map[string]Protocol
	byName    map[string]Protocol
}

func NewRegistry() *ProtocolRegistry {
	return &ProtocolRegistry{
		protocols: make(map[string]Protocol),
		byName:    make(map[string]Protocol),
	}
}

func (r *ProtocolRegistry) Register(p Protocol) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, ok := r.byName[p.Name()]; ok {
		return fmt.Errorf("protocol %q already registered", p.Name())
	}

	for _, scheme := range p.Schemes() {
		s := strings.ToLower(scheme)
		if ep, ok := r.protocols[s]; ok {
			return fmt.Errorf("scheme %q already registered by protocol %q", s, ep.Name())
		}
	}

	for _, scheme := range p.Schemes() {
		s := strings.ToLower(scheme)
		r.protocols[s] = p
	}
	r.byName[p.Name()] = p

	return nil
}

func (r *ProtocolRegistry) Get(scheme string) (Protocol, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	p, ok := r.protocols[strings.ToLower(scheme)]
	return p, ok
}

func (r *ProtocolRegistry) GetByName(name string) (Protocol, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	p, ok := r.byName[name]
	return p, ok
}

func (r *ProtocolRegistry) MatchURL(rawURL string) (Protocol, *ParsedURL, error) {
	scheme := extractScheme(rawURL)
	if scheme == "" {
		return nil, nil, fmt.Errorf("no scheme found in URL %q", rawURL)
	}

	r.mu.RLock()
	p, ok := r.protocols[strings.ToLower(scheme)]
	r.mu.RUnlock()

	if !ok {
		return nil, nil, fmt.Errorf("no protocol registered for scheme %q", scheme)
	}

	parsed, err := p.ParseURL(rawURL)
	if err != nil {
		return nil, nil, fmt.Errorf("parse URL %q: %w", rawURL, err)
	}

	return p, parsed, nil
}

func (r *ProtocolRegistry) List() []Protocol {
	r.mu.RLock()
	defer r.mu.RUnlock()

	seen := make(map[string]bool)
	result := make([]Protocol, 0, len(r.byName))
	for _, p := range r.byName {
		if !seen[p.Name()] {
			seen[p.Name()] = true
			result = append(result, p)
		}
	}
	return result
}

func (r *ProtocolRegistry) Schemes() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	schemes := make([]string, 0, len(r.protocols))
	for s := range r.protocols {
		schemes = append(schemes, s)
	}
	return schemes
}

func extractScheme(rawURL string) string {
	idx := strings.Index(rawURL, ":")
	if idx < 0 {
		return ""
	}
	scheme := rawURL[:idx]
	for _, r := range scheme {
		if !isSchemeChar(r) {
			return ""
		}
	}
	return scheme
}

func isSchemeChar(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '+' || r == '-' || r == '.'
}
