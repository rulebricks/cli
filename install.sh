#!/bin/sh
# Rulebricks CLI Installation Script
# This script installs the latest version of the Rulebricks CLI

set -e

# Default installation directory
INSTALL_DIR=${INSTALL_DIR:-"/usr/local/bin"}
BINARY_NAME="rulebricks"
GITHUB_REPO="rulebricks/cli"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Print colored output
print_error() {
    printf "${RED}Error: %s${NC}\n" "$1" >&2
}

print_success() {
    printf "${GREEN}%s${NC}\n" "$1"
}

print_info() {
    printf "${YELLOW}%s${NC}\n" "$1"
}

# Detect OS and architecture
detect_platform() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)

    case $OS in
        linux*)
            PLATFORM="linux"
            ;;
        darwin*)
            PLATFORM="darwin"
            ;;
        msys*|mingw*|cygwin*)
            PLATFORM="windows"
            ;;
        *)
            print_error "Unsupported operating system: $OS"
            exit 1
            ;;
    esac

    case $ARCH in
        x86_64|amd64)
            ARCH="x86_64"
            ;;
        aarch64|arm64)
            ARCH="arm64"
            ;;
        *)
            print_error "Unsupported architecture: $ARCH"
            exit 1
            ;;
    esac

    echo "${PLATFORM}_${ARCH}"
}

# Get the latest release version from GitHub
get_latest_version() {
    if command -v curl >/dev/null 2>&1; then
        VERSION=$(curl -s "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
    elif command -v wget >/dev/null 2>&1; then
        VERSION=$(wget -qO- "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
    else
        print_error "Neither curl nor wget found. Please install one of them."
        exit 1
    fi

    if [ -z "$VERSION" ]; then
        print_error "Failed to get latest version"
        exit 1
    fi

    echo "$VERSION"
}

# Download the binary
download_binary() {
    PLATFORM=$1
    VERSION=$2

    # Construct download URL
    FILENAME="${BINARY_NAME}_${VERSION#v}_${PLATFORM}"
    if [ "$PLATFORM" = "windows_x86_64" ]; then
        FILENAME="${FILENAME}.zip"
    else
        FILENAME="${FILENAME}.tar.gz"
    fi

    DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/download/${VERSION}/${FILENAME}"

    print_info "Downloading ${BINARY_NAME} ${VERSION} for ${PLATFORM}..."

    # Create temporary directory
    TMP_DIR=$(mktemp -d)
    trap "rm -rf $TMP_DIR" EXIT

    # Download the archive
    if command -v curl >/dev/null 2>&1; then
        curl -L -o "$TMP_DIR/$FILENAME" "$DOWNLOAD_URL" || {
            print_error "Failed to download ${BINARY_NAME}"
            exit 1
        }
    else
        wget -O "$TMP_DIR/$FILENAME" "$DOWNLOAD_URL" || {
            print_error "Failed to download ${BINARY_NAME}"
            exit 1
        }
    fi

    # Extract the binary
    print_info "Extracting ${BINARY_NAME}..."
    cd "$TMP_DIR"

    if [ "${FILENAME##*.}" = "zip" ]; then
        unzip -q "$FILENAME" || {
            print_error "Failed to extract archive"
            exit 1
        }
    else
        tar -xzf "$FILENAME" || {
            print_error "Failed to extract archive"
            exit 1
        }
    fi

    # Find the binary
    if [ ! -f "${BINARY_NAME}" ]; then
        print_error "Binary not found in archive"
        exit 1
    fi

    echo "$TMP_DIR/${BINARY_NAME}"
}

# Install the binary
install_binary() {
    BINARY_PATH=$1

    # Check if we need sudo
    if [ -w "$INSTALL_DIR" ]; then
        SUDO=""
    else
        if command -v sudo >/dev/null 2>&1; then
            print_info "Installation requires administrator privileges..."
            SUDO="sudo"
        else
            print_error "Cannot write to $INSTALL_DIR and sudo is not available"
            print_info "Please run as root or choose a different installation directory with INSTALL_DIR=<path>"
            exit 1
        fi
    fi

    # Create install directory if it doesn't exist
    if [ ! -d "$INSTALL_DIR" ]; then
        print_info "Creating installation directory $INSTALL_DIR..."
        $SUDO mkdir -p "$INSTALL_DIR" || {
            print_error "Failed to create installation directory"
            exit 1
        }
    fi

    # Install the binary
    print_info "Installing ${BINARY_NAME} to ${INSTALL_DIR}..."
    $SUDO cp "$BINARY_PATH" "$INSTALL_DIR/${BINARY_NAME}" || {
        print_error "Failed to install binary"
        exit 1
    }

    # Make it executable
    $SUDO chmod +x "$INSTALL_DIR/${BINARY_NAME}" || {
        print_error "Failed to make binary executable"
        exit 1
    }
}

# Verify installation
verify_installation() {
    if command -v "${BINARY_NAME}" >/dev/null 2>&1; then
        INSTALLED_VERSION=$("${BINARY_NAME}" version 2>/dev/null | grep -E "Version:" | awk '{print $2}') || true
        if [ -n "$INSTALLED_VERSION" ]; then
            print_success "${BINARY_NAME} ${INSTALLED_VERSION} has been successfully installed!"
        else
            print_success "${BINARY_NAME} has been successfully installed!"
        fi
        print_info "Run '${BINARY_NAME} --help' to get started"
    else
        print_error "${BINARY_NAME} was installed to ${INSTALL_DIR} but is not in your PATH"
        print_info "Add the following to your shell configuration file:"
        print_info "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    fi
}

# Main installation flow
main() {
    print_info "Installing Rulebricks CLI..."

    # Check for custom version
    if [ -n "$1" ]; then
        VERSION=$1
    else
        VERSION=$(get_latest_version)
    fi

    # Detect platform
    PLATFORM=$(detect_platform)

    # Download binary
    BINARY_PATH=$(download_binary "$PLATFORM" "$VERSION")

    # Install binary
    install_binary "$BINARY_PATH"

    # Verify installation
    verify_installation
}

# Run main function
main "$@"
