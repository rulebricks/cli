package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fatih/color"
)

// AssetManager handles extraction of Supabase assets and downloading of Terraform templates
type AssetManager struct {
	licenseKey string
	workDir    string
	verbose    bool
	httpClient *http.Client
}

// AssetManifest describes bundled assets
type AssetManifest struct {
	Version      string
	SupabasePath string
}

// NewAssetManager creates a new asset manager
func NewAssetManager(licenseKey, workDir string, verbose bool) (*AssetManager, error) {
	if err := os.MkdirAll(workDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create work directory: %w", err)
	}

	return &AssetManager{
		licenseKey: licenseKey,
		workDir:    workDir,
		verbose:    verbose,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}, nil
}

// EnsureSupabaseAssets extracts Supabase assets if not present
func (am *AssetManager) EnsureSupabaseAssets(imageName, targetDir string) error {
	// Check if Supabase assets already exist
	if am.validateSupabaseDir(targetDir) {
		if am.verbose {
			fmt.Println("✓ Supabase assets already present")
		}
		return nil
	}

	color.Yellow("📦 Copying Supabase assets...")

	// Look for local supabase directory
	sourceDir := "supabase"
	if _, err := os.Stat(sourceDir); os.IsNotExist(err) {
		// Try looking in parent directory
		sourceDir = "../supabase"
		if _, err := os.Stat(sourceDir); os.IsNotExist(err) {
			return fmt.Errorf("supabase directory not found in current or parent directory")
		}
	}

	// Copy the entire supabase directory to target
	if err := am.copyDirectory(sourceDir, targetDir); err != nil {
		return fmt.Errorf("failed to copy supabase assets: %w", err)
	}

	color.Green("✓ Supabase assets copied successfully")
	return nil
}

// copyDirectory recursively copies a directory tree
func (am *AssetManager) copyDirectory(src, dst string) error {
	// Get source directory info
	srcInfo, err := os.Stat(src)
	if err != nil {
		return err
	}

	// Create destination directory
	if err := os.MkdirAll(dst, srcInfo.Mode()); err != nil {
		return err
	}

	// Read source directory
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			// Recursively copy subdirectory
			if err := am.copyDirectory(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			// Copy file
			if err := am.copyFile(srcPath, dstPath); err != nil {
				return err
			}
		}
	}

	return nil
}

// copyFile copies a single file
func (am *AssetManager) copyFile(src, dst string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	// Get source file info
	srcInfo, err := sourceFile.Stat()
	if err != nil {
		return err
	}

	// Create destination file
	destFile, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, srcInfo.Mode())
	if err != nil {
		return err
	}
	defer destFile.Close()

	// Copy content
	if _, err := io.Copy(destFile, sourceFile); err != nil {
		return err
	}

	if am.verbose {
		fmt.Printf("  Copied: %s\n", filepath.Base(src))
	}

	return nil
}

// EnsureTerraformAssets downloads Terraform templates if not present locally
func (am *AssetManager) EnsureTerraformAssets(targetDir string) error {
	// Check if terraform directory exists with content
	if am.validateTerraformDir(targetDir) {
		if am.verbose {
			fmt.Println("✓ Terraform templates found locally")
		}
		return nil
	}

	color.Yellow("📥 Downloading Terraform templates...")

	// Download from GitHub
	archiveURL := "https://github.com/rulebricks/terraform/archive/refs/heads/main.tar.gz"

	if err := am.downloadAndExtractTerraform(archiveURL, targetDir); err != nil {
		return fmt.Errorf("failed to download Terraform templates: %w", err)
	}

	color.Green("✓ Terraform templates downloaded successfully")
	return nil
}

// downloadAndExtractTerraform downloads and extracts terraform templates
func (am *AssetManager) downloadAndExtractTerraform(url, targetDir string) error {
	// Download archive
	resp, err := am.httpClient.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed with status %d", resp.StatusCode)
	}

	// Create target directory
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return err
	}

	// Extract tar.gz
	gzr, err := gzip.NewReader(resp.Body)
	if err != nil {
		return err
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)

	// Extract files
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		// Calculate target path
		relativePath := header.Name
		// Skip the first directory component (terraform-main/)
		parts := strings.SplitN(relativePath, "/", 2)
		if len(parts) < 2 {
			continue
		}
		relativePath = parts[1]

		target := filepath.Join(targetDir, relativePath)

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}

			file, err := os.Create(target)
			if err != nil {
				return err
			}

			if _, err := io.Copy(file, tr); err != nil {
				file.Close()
				return err
			}
			file.Close()

			if am.verbose {
				fmt.Printf("  Downloaded: %s\n", relativePath)
			}
		}
	}

	return nil
}

// validateSupabaseDir checks if Supabase directory has required structure
func (am *AssetManager) validateSupabaseDir(dir string) bool {
	requiredDirs := []string{"migrations", "config", "emails"}

	for _, reqDir := range requiredDirs {
		path := filepath.Join(dir, reqDir)
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			return false
		}
	}

	// Check for config.example.toml
	configPath := filepath.Join(dir, "config", "config.example.toml")
	if _, err := os.Stat(configPath); err != nil {
		return false
	}

	return true
}

// validateTerraformDir checks if terraform directory has content
func (am *AssetManager) validateTerraformDir(dir string) bool {
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return false
	}

	// Check for any .tf files
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}

	// Look for terraform files or provider directories
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tf") {
			return true
		}
		if entry.IsDir() && (entry.Name() == "aws" || entry.Name() == "gcp" || entry.Name() == "azure") {
			// Check if provider directory has .tf files
			providerDir := filepath.Join(dir, entry.Name())
			providerEntries, err := os.ReadDir(providerDir)
			if err == nil {
				for _, pEntry := range providerEntries {
					if strings.HasSuffix(pEntry.Name(), ".tf") {
						return true
					}
				}
			}
		}
	}

	return false
}

// Close cleans up resources
func (am *AssetManager) Close() error {
	// No resources to clean up in this implementation
	return nil
}

// DNSVerifier handles DNS verification
type DNSVerifier struct {
	domain   string
	endpoint string
	verbose  bool
}

// NewDNSVerifier creates a new DNS verifier
func NewDNSVerifier(domain, endpoint string, verbose bool) *DNSVerifier {
	return &DNSVerifier{
		domain:   domain,
		endpoint: endpoint,
		verbose:  verbose,
	}
}

// Verify checks if DNS is properly configured
func (dv *DNSVerifier) Verify(ctx context.Context) error {
	// In a real implementation, this would perform actual DNS lookups
	// For now, we'll simulate the check

	if dv.verbose {
		fmt.Printf("Checking DNS for %s -> %s\n", dv.domain, dv.endpoint)
	}

	// Simulate DNS check with timeout
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(2 * time.Second):
		// Simulate that DNS might not be configured yet
		return fmt.Errorf("DNS record not found for %s", dv.domain)
	}
}
