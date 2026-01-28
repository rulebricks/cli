#!/bin/bash
# Rulebricks CLI Install Script
# https://github.com/rulebricks/cli
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/rulebricks/cli/main/install.sh | bash
#   
# Options:
#   VERSION=v2.0.0 curl -fsSL ... | bash   # Install specific version
#   INSTALL_DIR=/custom/path curl -fsSL ... | bash

set -e

# Configuration
REPO="rulebricks/cli"
BINARY_NAME="rulebricks"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Logging functions
info() { echo -e "${BLUE}ℹ${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; exit 1; }

# Detect OS and architecture
detect_platform() {
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Linux*)  OS="Linux" ;;
        Darwin*) OS="Darwin" ;;
        MINGW*|MSYS*|CYGWIN*) OS="Windows" ;;
        *) error "Unsupported operating system: $OS" ;;
    esac

    case "$ARCH" in
        x86_64|amd64) ARCH="x86_64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *) error "Unsupported architecture: $ARCH" ;;
    esac

    # Windows doesn't support arm64 binaries
    if [ "$OS" = "Windows" ] && [ "$ARCH" = "arm64" ]; then
        error "Windows ARM64 is not supported. Please use WSL or the npm package."
    fi
}

# Get latest release version
get_latest_version() {
    if [ -n "$VERSION" ]; then
        echo "$VERSION"
        return
    fi

    LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
    
    if [ -z "$LATEST" ]; then
        error "Could not determine latest version. Please specify VERSION explicitly."
    fi
    
    echo "$LATEST"
}

# Download and install
install() {
    detect_platform
    VERSION=$(get_latest_version)

    echo ""
    echo -e "${MAGENTA}╭─────────────────────────────────────╮${NC}"
    echo -e "${MAGENTA}│${NC}       ${CYAN}Rulebricks CLI Installer${NC}       ${MAGENTA}│${NC}"
    echo -e "${MAGENTA}╰─────────────────────────────────────╯${NC}"
    echo ""

    info "Detected platform: ${OS} ${ARCH}"
    info "Installing version: ${VERSION}"

    # Construct download URL
    if [ "$OS" = "Windows" ]; then
        ARCHIVE_NAME="${BINARY_NAME}_${VERSION}_${OS}_${ARCH}.zip"
    else
        ARCHIVE_NAME="${BINARY_NAME}_${VERSION}_${OS}_${ARCH}.tar.gz"
    fi
    
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ARCHIVE_NAME}"

    # Create temp directory
    TMP_DIR=$(mktemp -d)
    trap "rm -rf $TMP_DIR" EXIT

    # Download
    info "Downloading ${ARCHIVE_NAME}..."
    if ! curl -fsSL "$DOWNLOAD_URL" -o "$TMP_DIR/$ARCHIVE_NAME"; then
        error "Failed to download from ${DOWNLOAD_URL}"
    fi

    # Extract
    info "Extracting..."
    cd "$TMP_DIR"
    if [ "$OS" = "Windows" ]; then
        unzip -q "$ARCHIVE_NAME"
        BINARY_FILE=$(ls rulebricks-*.exe 2>/dev/null | head -1)
    else
        tar -xzf "$ARCHIVE_NAME"
        BINARY_FILE=$(ls rulebricks-* 2>/dev/null | head -1)
    fi

    if [ -z "$BINARY_FILE" ]; then
        error "Could not find binary in archive"
    fi

    # Install
    info "Installing to ${INSTALL_DIR}..."
    
    # Check if we need sudo
    if [ -w "$INSTALL_DIR" ]; then
        mv "$BINARY_FILE" "${INSTALL_DIR}/${BINARY_NAME}"
        chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
    else
        warn "Elevated permissions required to install to ${INSTALL_DIR}"
        sudo mv "$BINARY_FILE" "${INSTALL_DIR}/${BINARY_NAME}"
        sudo chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
    fi

    echo ""
    success "Rulebricks CLI ${VERSION} installed successfully!"
    echo ""
    echo -e "  Run ${CYAN}rulebricks --help${NC} to get started"
    echo -e "  Run ${CYAN}rulebricks init${NC} to create a new deployment configuration"
    echo ""

    # Check if install dir is in PATH
    if ! echo "$PATH" | grep -q "$INSTALL_DIR"; then
        warn "${INSTALL_DIR} is not in your PATH"
        echo "  Add it to your shell profile:"
        echo ""
        echo "    export PATH=\"\$PATH:${INSTALL_DIR}\""
        echo ""
    fi
}

# Alternative: install via npm
install_npm() {
    echo ""
    echo -e "${MAGENTA}╭─────────────────────────────────────╮${NC}"
    echo -e "${MAGENTA}│${NC}       ${CYAN}Rulebricks CLI Installer${NC}       ${MAGENTA}│${NC}"
    echo -e "${MAGENTA}╰─────────────────────────────────────╯${NC}"
    echo ""

    if command -v npm &> /dev/null; then
        info "npm detected. Installing via npm..."
        npm install -g @rulebricks/cli
        success "Rulebricks CLI installed via npm!"
        echo ""
        echo -e "  Run ${CYAN}rulebricks --help${NC} to get started"
        echo ""
    else
        warn "npm not found. Installing standalone binary..."
        install
    fi
}

# Parse arguments
case "${1:-}" in
    --npm)
        install_npm
        ;;
    --help|-h)
        echo "Rulebricks CLI Installer"
        echo ""
        echo "Usage:"
        echo "  curl -fsSL https://raw.githubusercontent.com/rulebricks/cli/main/install.sh | bash"
        echo ""
        echo "Options:"
        echo "  --npm          Install via npm instead of standalone binary"
        echo "  --help, -h     Show this help message"
        echo ""
        echo "Environment variables:"
        echo "  VERSION        Install specific version (e.g., VERSION=v2.0.0)"
        echo "  INSTALL_DIR    Custom installation directory (default: /usr/local/bin)"
        ;;
    *)
        install
        ;;
esac
