# Rulebricks Deploy CLI

## Quick Install (Recommended)

### macOS and Linux

Use the install script:

```bash
curl -sSfL https://raw.githubusercontent.com/rulebricks/cli/main/install.sh | sh
```

Or if you prefer wget:

```bash
wget -qO- https://raw.githubusercontent.com/rulebricks/cli/main/install.sh | sh
```

### Windows

Download the latest Windows binary from the [releases page](https://github.com/rulebricks/cli/releases/latest) and add it to your PATH.

## Manual Installation

### 1. Download the Binary

Visit the [releases page](https://github.com/rulebricks/cli/releases/latest) and download the appropriate archive for your platform:

- **macOS Intel**: `rulebricks_<version>_Darwin_x86_64.tar.gz`
- **macOS Apple Silicon**: `rulebricks_<version>_Darwin_arm64.tar.gz`
- **Linux x64**: `rulebricks_<version>_Linux_x86_64.tar.gz`
- **Linux ARM64**: `rulebricks_<version>_Linux_arm64.tar.gz`
- **Windows**: `rulebricks_<version>_Windows_x86_64.zip`

### 2. Extract and Install

#### macOS/Linux

```bash
# Download (replace URL with your platform's download link)
curl -L -o rulebricks.tar.gz https://github.com/rulebricks/cli/releases/download/v1.0.0/rulebricks_1.0.0_Linux_x86_64.tar.gz

# Extract
tar -xzf rulebricks.tar.gz

# Make executable
chmod +x rulebricks

# Move to PATH
sudo mv rulebricks /usr/local/bin/

# Or without sudo, move to user bin
mkdir -p ~/.local/bin
mv rulebricks ~/.local/bin/
# Add ~/.local/bin to your PATH if not already there
```

#### Windows

1. Extract the ZIP file
2. Move `rulebricks.exe` to a directory in your PATH
3. Or add the directory containing `rulebricks.exe` to your PATH

## Install from Source

If you have Go 1.21+ installed:

```bash
git clone https://github.com/rulebricks/cli.git
cd cli
make install
```

Or directly with go install:

```bash
go install github.com/rulebricks/cli/src@latest
```

## Verify Installation

After installation, verify it works:

```bash
rulebricks version
```

You should see output like:
```
Rulebricks CLI
  Version:    1.0.0
  Git commit: abc1234
  Built:      2024-01-01T00:00:00Z
  Go version: go1.21
  OS/Arch:    darwin/arm64
```

## Updating

To update to the latest version:

### Using Install Script
```bash
curl -sSfL https://raw.githubusercontent.com/rulebricks/cli/main/install.sh | sh
```

### Manual Update
Download and install the new version following the manual installation steps above.

## Uninstalling

### If installed to /usr/local/bin
```bash
sudo rm /usr/local/bin/rulebricks
```

### If installed elsewhere
```bash
rm $(which rulebricks)
```

## Troubleshooting

### Command not found

If you get "command not found" after installation, ensure the installation directory is in your PATH:

```bash
echo $PATH
```

Add to PATH if needed:
```bash
# For bash
echo 'export PATH="/usr/local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# For zsh
echo 'export PATH="/usr/local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Permission denied

If you get permission errors during installation:
- Use `sudo` for system-wide installation
- Or install to a user directory like `~/.local/bin`

### Verification fails

If the CLI doesn't run after installation:
1. Check the file is executable: `ls -la $(which rulebricks)`
2. Check your system architecture matches the downloaded binary
3. On macOS, you may need to allow the binary in System Preferences > Security & Privacy

## Next Steps

Once installed, you can:

1. Initialize a new configuration: `rulebricks init`
2. View help: `rulebricks --help`
3. Deploy Rulebricks: `rulebricks deploy`

## Support

For issues or questions:
- [GitHub Issues](https://github.com/rulebricks/cli/issues)
- [Documentation](https://github.com/rulebricks/cli#readme)
