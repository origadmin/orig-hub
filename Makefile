.PHONY: build test test-integration test-frontend test-e2e test-screenshots lint cover clean gui

BINARY=bin/orighub
GO=go
WAILS=wails

build:
	$(GO) build -o $(BINARY) .

test:
	$(GO) test -race ./...

test-integration:
	$(GO) test -race -tags=integration ./...

test-frontend:
	cd ui && npm install && npm test

test-e2e:
	cd ui && npm run test:e2e

test-screenshots:
	cd ui && npm run test:e2e -- --screenshot

lint:
	golangci-lint run

cover:
	$(GO) test -race -coverprofile=coverage.out ./...
	$(GO) tool cover -html=coverage.out -o coverage.html

clean:
	rm -rf bin/ build/ coverage.out coverage.html

gui:
	$(WAILS) dev
