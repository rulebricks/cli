# Makefile for Rulebricks CLI

# Variables
BINARY_NAME=rulebricks
VERSION?=dev
COMMIT=$(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE=$(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS=-ldflags "-X main.version=${VERSION} -X main.gitCommit=${COMMIT} -X main.buildDate=${BUILD_DATE}"
GOPATH?=$(shell go env GOPATH)
INSTALL_PATH=$(GOPATH)/bin

# Go build settings
GO=go
GOFLAGS=-mod=readonly
GOBUILD=$(GO) build $(GOFLAGS) $(LDFLAGS)


# Platforms
PLATFORMS=darwin linux windows
ARCHITECTURES=amd64 arm64

# Default target
.PHONY: all
all: build

# Build binary for current platform
.PHONY: build
build:
	@echo "Building $(BINARY_NAME) ${VERSION} (${COMMIT})..."
	@$(GOBUILD) -o $(BINARY_NAME) ./src

# Install binary to GOPATH/bin
.PHONY: install
install: build
	@echo "Installing $(BINARY_NAME) to $(INSTALL_PATH)..."
	@install -d $(INSTALL_PATH)
	@install -m 755 $(BINARY_NAME) $(INSTALL_PATH)/$(BINARY_NAME)

# Uninstall binary
.PHONY: uninstall
uninstall:
	@echo "Removing $(BINARY_NAME) from $(INSTALL_PATH)..."
	@rm -f $(INSTALL_PATH)/$(BINARY_NAME)



# Format code
.PHONY: fmt
fmt:
	@echo "Formatting code..."
	@$(GO) fmt ./src/...

# Tidy dependencies
.PHONY: tidy
tidy:
	@echo "Tidying dependencies..."
	@$(GO) mod tidy

# Clean build artifacts
.PHONY: clean
clean:
	@echo "Cleaning build artifacts..."
	@rm -f $(BINARY_NAME)
	@rm -rf dist/


# Build for all platforms
.PHONY: build-all
build-all: clean
	@echo "Building for all platforms..."
	@mkdir -p dist
	@for platform in $(PLATFORMS); do \
		for arch in $(ARCHITECTURES); do \
			if [ "$$platform" = "windows" ]; then \
				ext=".exe"; \
			else \
				ext=""; \
			fi; \
			if [ "$$platform" = "darwin" ] && [ "$$arch" = "arm64" ]; then \
				echo "Building for $$platform/$$arch..."; \
			elif [ "$$platform" = "darwin" ] && [ "$$arch" = "amd64" ]; then \
				echo "Building for $$platform/$$arch..."; \
			elif [ "$$platform" = "linux" ]; then \
				echo "Building for $$platform/$$arch..."; \
			elif [ "$$platform" = "windows" ] && [ "$$arch" = "amd64" ]; then \
				echo "Building for $$platform/$$arch..."; \
			else \
				continue; \
			fi; \
			GOOS=$$platform GOARCH=$$arch $(GOBUILD) -o dist/$(BINARY_NAME)-$$platform-$$arch$$ext ./src; \
		done; \
	done

# Create release archives
.PHONY: release
release: build-all
	@echo "Creating release archives..."
	@cd dist && for file in $(BINARY_NAME)-*; do \
		if [ -f "$$file" ]; then \
			tar czf "$$file.tar.gz" "$$file"; \
			rm "$$file"; \
		fi; \
	done
	@echo "Release archives created in dist/"

# Create checksums
.PHONY: checksums
checksums:
	@echo "Creating checksums..."
	@cd dist && shasum -a 256 *.tar.gz > checksums.txt

# Development build (with race detector)
.PHONY: dev
dev:
	@echo "Building development version with race detector..."
	@$(GO) build -race $(LDFLAGS) -o $(BINARY_NAME) ./src

# Run the CLI
.PHONY: run
run: build
	@./$(BINARY_NAME)

# Update dependencies
.PHONY: deps
deps:
	@echo "Updating dependencies..."
	@$(GO) mod download

# Verify dependencies
.PHONY: verify
verify:
	@echo "Verifying dependencies..."
	@$(GO) mod verify

# Show version
.PHONY: version
version:
	@echo "Version: ${VERSION}"
	@echo "Commit: ${COMMIT}"
	@echo "Build Date: ${BUILD_DATE}"

# Help
.PHONY: help
help:
	@echo "Rulebricks CLI Makefile"
	@echo ""
	@echo "Usage:"
	@echo "  make build          Build binary for current platform"
	@echo "  make install        Install binary to GOPATH/bin"
	@echo "  make uninstall      Remove binary from GOPATH/bin"

	@echo "  make fmt            Format code"
	@echo "  make tidy           Tidy dependencies"
	@echo "  make clean          Clean build artifacts"
	@echo "  make build-all      Build for all platforms"
	@echo "  make release        Create release archives"
	@echo "  make checksums      Generate checksums for releases"
	@echo "  make dev            Build with race detector"
	@echo "  make run            Build and run"
	@echo "  make deps           Download dependencies"
	@echo "  make verify         Verify dependencies"
	@echo "  make version        Show version info"
	@echo ""
	@echo "Variables:"
	@echo "  VERSION=x.y.z       Set version (default: dev)"

.DEFAULT_GOAL := help
