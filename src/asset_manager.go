package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/fatih/color"
)

type AssetManager struct {
	licenseKey string
	workDir    string
	verbose    bool
	httpClient *http.Client
}

type AssetManifest struct {
	Version      string
	SupabasePath string
}

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

func (am *AssetManager) EnsureSupabaseAssets(imageName, targetDir string) error {
	if am.validateSupabaseDir(targetDir) {
		if am.verbose {
			fmt.Println("✓ Supabase assets already present")
		}
		return nil
	}

	color.Yellow("📦 Extracting Supabase assets...")

	if imageName != "" {
		if am.verbose {
			fmt.Printf("Extracting from Docker image: %s\n", imageName)
		}

		dockerPassword := fmt.Sprintf("dckr_pat_%s", am.licenseKey)
		loginCmd := exec.Command("docker", "login", "docker.io", "-u", "rulebricks", "-p", dockerPassword)
		if err := loginCmd.Run(); err != nil {
			if am.verbose {
				fmt.Printf("Warning: Docker login failed: %v\n", err)
			}
		}

		containerName := fmt.Sprintf("rulebricks-extract-%d", time.Now().Unix())
		createCmd := exec.Command("docker", "create", "--name", containerName, imageName)
		if err := createCmd.Run(); err != nil {
			return fmt.Errorf("failed to create container from image %s: %w", imageName, err)
		}

		defer func() {
			removeCmd := exec.Command("docker", "rm", "-f", containerName)
			removeCmd.Run()
		}()

		copyCmd := exec.Command("docker", "cp",
			fmt.Sprintf("%s:/opt/rulebricks/assets/supabase", containerName), targetDir)
		if err := copyCmd.Run(); err != nil {
			return fmt.Errorf("failed to extract supabase assets from image: %w", err)
		}

		color.Green("✓ Supabase assets extracted successfully from Docker image")
		return nil
	}

	sourceDir := "supabase"
	if _, err := os.Stat(sourceDir); os.IsNotExist(err) {
		sourceDir = "../supabase"
		if _, err := os.Stat(sourceDir); os.IsNotExist(err) {
			return fmt.Errorf("supabase directory not found in current or parent directory")
		}
	}

	if err := am.copyDirectory(sourceDir, targetDir); err != nil {
		return fmt.Errorf("failed to copy supabase assets: %w", err)
	}

	color.Green("✓ Supabase assets copied successfully from local directory")
	return nil
}

func (am *AssetManager) copyDirectory(src, dst string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(dst, srcInfo.Mode()); err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			if err := am.copyDirectory(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			if err := am.copyFile(srcPath, dstPath); err != nil {
				return err
			}
		}
	}

	return nil
}

func (am *AssetManager) copyFile(src, dst string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	srcInfo, err := sourceFile.Stat()
	if err != nil {
		return err
	}

	destFile, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, srcInfo.Mode())
	if err != nil {
		return err
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, sourceFile); err != nil {
		return err
	}

	if am.verbose {
		fmt.Printf("  Copied: %s\n", filepath.Base(src))
	}

	return nil
}

func (am *AssetManager) EnsureTerraformAssets(targetDir string) error {
	if am.validateTerraformDir(targetDir) {
		if am.verbose {
			fmt.Println("✓ Terraform templates found locally")
		}
		return nil
	}

	color.Yellow("📥 Downloading Terraform templates...")

	archiveURL := "https://github.com/rulebricks/terraform/archive/refs/heads/main.tar.gz"

	if err := am.downloadAndExtractTerraform(archiveURL, targetDir); err != nil {
		return fmt.Errorf("failed to download Terraform templates: %w", err)
	}

	color.Green("✓ Terraform templates downloaded successfully")
	return nil
}

func (am *AssetManager) downloadAndExtractTerraform(url, targetDir string) error {
	resp, err := am.httpClient.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed with status %d", resp.StatusCode)
	}

	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return err
	}

	gzr, err := gzip.NewReader(resp.Body)
	if err != nil {
		return err
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)

	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		relativePath := header.Name
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

func (am *AssetManager) validateSupabaseDir(dir string) bool {
	requiredDirs := []string{"migrations", "config", "emails"}

	for _, reqDir := range requiredDirs {
		path := filepath.Join(dir, reqDir)
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			return false
		}
	}

	configPath := filepath.Join(dir, "config", "config.example.toml")
	if _, err := os.Stat(configPath); err != nil {
		return false
	}

	return true
}

func (am *AssetManager) validateTerraformDir(dir string) bool {
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return false
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}

	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tf") {
			return true
		}
		if entry.IsDir() && (entry.Name() == "aws" || entry.Name() == "gcp" || entry.Name() == "azure") {
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

func (am *AssetManager) Close() error {
	return nil
}

type DNSVerifier struct {
	domain   string
	endpoint string
	verbose  bool
}

func NewDNSVerifier(domain, endpoint string, verbose bool) *DNSVerifier {
	return &DNSVerifier{
		domain:   domain,
		endpoint: endpoint,
		verbose:  verbose,
	}
}

func (dv *DNSVerifier) Verify(ctx context.Context) error {
	if dv.verbose {
		fmt.Printf("Checking DNS for %s -> %s\n", dv.domain, dv.endpoint)
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(2 * time.Second):
		return fmt.Errorf("DNS record not found for %s", dv.domain)
	}
}
