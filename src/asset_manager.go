// asset_manager.go - Manages external assets (Supabase from Docker, Terraform from GitHub)
package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/registry"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/fatih/color"
)

// AssetManager handles extraction of Supabase assets and downloading of Terraform templates
type AssetManager struct {
	dockerClient   *client.Client
	httpClient     *http.Client
	licenseKey     string
	workDir        string
	verbose        bool
	terraformRepo  string
	terraformOwner string
}

// AssetManifest describes bundled assets in the Docker image
type AssetManifest struct {
	Version      string `json:"version"`
	SupabasePath string `json:"supabase_path"`
}

// NewAssetManager creates a new asset manager
func NewAssetManager(licenseKey, workDir string, verbose bool) (*AssetManager, error) {
	dockerCli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("failed to create Docker client: %w", err)
	}

	if err := os.MkdirAll(workDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create work directory: %w", err)
	}

	return &AssetManager{
		dockerClient: dockerCli,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		licenseKey:     licenseKey,
		workDir:        workDir,
		verbose:        verbose,
		terraformRepo:  "terraform",
		terraformOwner: "rulebricks",
	}, nil
}

// EnsureSupabaseAssets extracts Supabase assets from Docker image if not present
func (am *AssetManager) EnsureSupabaseAssets(imageName, targetDir string) error {
	// Check if Supabase assets already exist
	if am.validateSupabaseDir(targetDir) {
		if am.verbose {
			fmt.Println("✓ Supabase assets already present")
		}
		return nil
	}

	color.Yellow("📦 Extracting Supabase assets from Docker image...")

	ctx := context.Background()

	// Pull the image using license key
	if err := am.pullDockerImage(ctx, imageName); err != nil {
		return fmt.Errorf("failed to pull Docker image: %w", err)
	}

	// Get asset manifest
	manifest, err := am.getAssetManifest(ctx, imageName)
	if err != nil {
		return fmt.Errorf("failed to read asset manifest: %w", err)
	}

	// Extract Supabase assets
	if err := am.extractFromContainer(ctx, imageName, manifest.SupabasePath, targetDir); err != nil {
		return fmt.Errorf("failed to extract Supabase assets: %w", err)
	}

	color.Green("✓ Supabase assets extracted successfully")
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

	color.Yellow("📥 Downloading Terraform templates from GitHub...")

	// Download from GitHub
	archiveURL := fmt.Sprintf("https://github.com/%s/%s/archive/refs/heads/main.tar.gz",
		am.terraformOwner, am.terraformRepo)

	if err := am.downloadAndExtractTerraform(archiveURL, targetDir); err != nil {
		return fmt.Errorf("failed to download Terraform templates: %w", err)
	}

	color.Green("✓ Terraform templates downloaded successfully")
	return nil
}

// pullDockerImage pulls the Docker image with license key authentication
func (am *AssetManager) pullDockerImage(ctx context.Context, imageName string) error {
	authConfig := registry.AuthConfig{
		Username: "license",
		Password: am.licenseKey,
	}

	encodedAuth, err := json.Marshal(authConfig)
	if err != nil {
		return err
	}

	pullOptions := image.PullOptions{
		RegistryAuth: base64.URLEncoding.EncodeToString(encodedAuth),
	}

	reader, err := am.dockerClient.ImagePull(ctx, imageName, pullOptions)
	if err != nil {
		return err
	}
	defer reader.Close()

	// Discard output unless verbose
	if am.verbose {
		_, err = io.Copy(os.Stdout, reader)
	} else {
		_, err = io.Copy(io.Discard, reader)
	}

	return err
}

// getAssetManifest reads the asset manifest from the container
func (am *AssetManager) getAssetManifest(ctx context.Context, imageName string) (*AssetManifest, error) {
	// Create temporary container
	resp, err := am.dockerClient.ContainerCreate(ctx, &container.Config{
		Image: imageName,
		Cmd:   []string{"cat", "/opt/rulebricks/assets/manifest.json"},
	}, nil, nil, nil, "")
	if err != nil {
		return nil, err
	}
	defer am.dockerClient.ContainerRemove(ctx, resp.ID, container.RemoveOptions{})

	// Start container
	if err := am.dockerClient.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		return nil, err
	}

	// Wait for completion
	statusCh, errCh := am.dockerClient.ContainerWait(ctx, resp.ID, container.WaitConditionNotRunning)
	select {
	case err := <-errCh:
		if err != nil {
			return nil, err
		}
	case <-statusCh:
	}

	// Get logs
	options := container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
	}

	logs, err := am.dockerClient.ContainerLogs(ctx, resp.ID, options)
	if err != nil {
		return nil, err
	}
	defer logs.Close()

	var buf strings.Builder
	_, err = stdcopy.StdCopy(&buf, io.Discard, logs)
	if err != nil {
		return nil, err
	}

	var manifest AssetManifest
	if err := json.Unmarshal([]byte(buf.String()), &manifest); err != nil {
		return nil, fmt.Errorf("failed to parse manifest: %w", err)
	}

	return &manifest, nil
}

// extractFromContainer extracts files from container to local directory
func (am *AssetManager) extractFromContainer(ctx context.Context, imageName, srcPath, dstPath string) error {
	// Create temporary container
	resp, err := am.dockerClient.ContainerCreate(ctx, &container.Config{
		Image: imageName,
	}, nil, nil, nil, "")
	if err != nil {
		return err
	}
	defer am.dockerClient.ContainerRemove(ctx, resp.ID, container.RemoveOptions{})

	// Copy content
	reader, _, err := am.dockerClient.CopyFromContainer(ctx, resp.ID, srcPath)
	if err != nil {
		return err
	}
	defer reader.Close()

	// Extract tar archive
	tarReader := tar.NewReader(reader)

	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		// Clean path - remove first directory component
		cleanPath := header.Name
		parts := strings.Split(cleanPath, "/")
		if len(parts) > 1 {
			cleanPath = strings.Join(parts[1:], "/")
		}

		if cleanPath == "" {
			continue
		}

		target := filepath.Join(dstPath, cleanPath)

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}

			file, err := os.OpenFile(target, os.O_CREATE|os.O_RDWR, os.FileMode(header.Mode))
			if err != nil {
				return err
			}

			if _, err := io.Copy(file, tarReader); err != nil {
				file.Close()
				return err
			}
			file.Close()

			if am.verbose {
				fmt.Printf("  Extracted: %s\n", cleanPath)
			}
		}
	}

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

	// Extract tar.gz
	gzr, err := gzip.NewReader(resp.Body)
	if err != nil {
		return err
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)

	// Find terraform directory prefix
	var prefix string
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		// Look for terraform directory
		if header.Typeflag == tar.TypeDir && strings.Contains(header.Name, "terraform") {
			prefix = header.Name
			if !strings.HasSuffix(prefix, "/") {
				prefix += "/"
			}
			break
		}
	}

	// Re-download for extraction (simpler than seeking)
	resp, err = am.httpClient.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	gzr, err = gzip.NewReader(resp.Body)
	if err != nil {
		return err
	}
	defer gzr.Close()

	tr = tar.NewReader(gzr)

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
		if prefix != "" {
			// If we're looking at the terraform directory itself
			if header.Name == prefix || header.Name == strings.TrimSuffix(prefix, "/") {
				relativePath = ""
			} else if strings.HasPrefix(header.Name, prefix) {
				relativePath = strings.TrimPrefix(header.Name, prefix)
			} else {
				continue // Skip files not in terraform directory
			}
		}

		if relativePath == "" && header.Typeflag != tar.TypeDir {
			continue
		}

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
	if am.dockerClient != nil {
		return am.dockerClient.Close()
	}
	return nil
}
