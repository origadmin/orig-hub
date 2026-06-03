package i18n

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const (
	DefaultLocale = "en"
	FallbackLocale = "en"
)

var (
	global *I18n
	once   sync.Once
)

type I18n struct {
	mu       sync.RWMutex
	locale   string
	messages map[string]map[string]string
	loaded   map[string]bool
	dir      string
}

func init() {
	global = New()
}

func New() *I18n {
	i := &I18n{
		locale:   DefaultLocale,
		messages: make(map[string]map[string]string),
		loaded:   make(map[string]bool),
	}
	i.embedBuiltin()
	return i
}

func (i *I18n) embedBuiltin() {
	i.messages["en"] = builtinEn
	i.messages["zh-CN"] = builtinZhCN
	i.messages["ja"] = builtinJa
	i.loaded["en"] = true
	i.loaded["zh-CN"] = true
	i.loaded["ja"] = true
}

func (i *I18n) SetDir(dir string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.dir = dir
}

func (i *I18n) loadFromDir(locale string) error {
	if i.dir == "" {
		return nil
	}
	fp := filepath.Join(i.dir, locale+".json")
	data, err := os.ReadFile(fp)
	if err != nil {
		return fmt.Errorf("read locale file %s: %w", fp, err)
	}
	var m map[string]string
	if err := json.Unmarshal(data, &m); err != nil {
		return fmt.Errorf("parse locale file %s: %w", fp, err)
	}
	i.messages[locale] = m
	i.loaded[locale] = true
	return nil
}

func (i *I18n) SetLocale(locale string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if locale == i.locale {
		return
	}
	if _, ok := i.messages[locale]; !ok {
		if !i.loaded[locale] {
			_ = i.loadFromDir(locale)
		}
		if _, ok := i.messages[locale]; !ok {
			return
		}
	}
	i.locale = locale
}

func (i *I18n) GetLocale() string {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.locale
}

func (i *I18n) T(key string, args ...any) string {
	i.mu.RLock()
	defer i.mu.RUnlock()

	if m, ok := i.messages[i.locale]; ok {
		if v, ok := m[key]; ok {
			if len(args) > 0 {
				return fmt.Sprintf(v, args...)
			}
			return v
		}
	}
	if i.locale != FallbackLocale {
		if m, ok := i.messages[FallbackLocale]; ok {
			if v, ok := m[key]; ok {
				if len(args) > 0 {
					return fmt.Sprintf(v, args...)
				}
				return v
			}
		}
	}
	return key
}

func (i *I18n) AvailableLocales() []string {
	i.mu.RLock()
	defer i.mu.RUnlock()
	locales := make([]string, 0, len(i.messages))
	for k := range i.messages {
		locales = append(locales, k)
	}
	return locales
}

func (i *I18n) LoadExternalFile(path string) error {
	i.mu.Lock()
	defer i.mu.Unlock()

	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read locale file: %w", err)
	}
	var m map[string]string
	if err := json.Unmarshal(data, &m); err != nil {
		return fmt.Errorf("parse locale file: %w", err)
	}
	name := filepath.Base(path)
	name = name[:len(name)-len(filepath.Ext(name))]
	i.messages[name] = m
	i.loaded[name] = true
	return nil
}

func (i *I18n) LoadDir(dir string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.dir = dir

	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read locale dir: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		locale := e.Name()[:len(e.Name())-5]
		if i.loaded[locale] {
			continue
		}
		fp := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(fp)
		if err != nil {
			continue
		}
		var m map[string]string
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		i.messages[locale] = m
		i.loaded[locale] = true
	}
	return nil
}

func SetDir(dir string) { global.SetDir(dir) }
func SetLocale(locale string) { global.SetLocale(locale) }
func GetLocale() string { return global.GetLocale() }
func T(key string, args ...any) string { return global.T(key, args...) }
func AvailableLocales() []string { return global.AvailableLocales() }
func LoadExternalFile(path string) error { return global.LoadExternalFile(path) }
func LoadDir(dir string) error { return global.LoadDir(dir) }
