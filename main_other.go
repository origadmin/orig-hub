//go:build !windows

package main

func readSystemLocaleRawImpl() string {
	return envLocale()
}
