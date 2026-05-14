.PHONY: build test test-integration test-frontend test-e2e test-screenshots lint cover clean daemon gui

BINARY=bin/orig-hub
GO=go
WAILS=wails

build:
	$(GO) build -o $(BINARY) ./cmd/orig-hub

test:
	$(GO) test -race ./...

test-integration:
	$(GO) test -race -tags=integration ./...

test-frontend:
	cd frontend && bun install && bun test

test-e2e:
	cd frontend && bun run test:e2e

test-screenshots:
	cd frontend && bun run test:e2e -- --screenshot

lint:
	golangci-lint run

cover:
	$(GO) test -race -coverprofile=coverage.out ./...
	$(GO) tool cover -html=coverage.out -o coverage.html

clean:
	rm -rf bin/ build/ coverage.out coverage.html

daemon:
	$(GO) run ./cmd/orig-hub daemon

gui:
	$(WAILS) dev
