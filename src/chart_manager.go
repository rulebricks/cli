package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/fatih/color"
)

type ChartManager struct {
	cacheDir   string
	baseURL    string
	httpClient *http.Client
	verbose    bool
}

type ChartInfo struct {
	Name       string
	Version    string
	URL        string
	SHA256     string
	Downloaded bool
	CachedPath string
}

func NewChartManager(cacheDir string, verbose bool) (*ChartManager, error) {
	if cacheDir == "" {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		cacheDir = filepath.Join(homeDir, ".rulebricks", "charts")
	}

	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create cache directory: %w", err)
	}

	return &ChartManager{
		cacheDir: cacheDir,
		baseURL:  "https://github.com/rulebricks/charts/releases/download",
		httpClient: &http.Client{
			Timeout: 5 * time.Minute,
		},
		verbose: verbose,
	}, nil
}

func (cm *ChartManager) PullChart(version string) (*ChartInfo, error) {
	if version == "" || version == "latest" {
		var err error
		version, err = cm.GetLatestVersion()
		if err != nil {
			return nil, fmt.Errorf("failed to get latest version: %w", err)
		}
		if cm.verbose {
			fmt.Printf("📌 Latest version: %s\n", version)
		}
	}

	return cm.getChart("rulebricks", version)
}

func (cm *ChartManager) PullSupabaseChart(version string) (*ChartInfo, error) {
	if version == "" || version == "latest" {
		var err error
		version, err = cm.GetLatestVersion()
		if err != nil {
			return nil, fmt.Errorf("failed to get latest version: %w", err)
		}
	}

	return cm.getChart("supabase", version)
}

func (cm *ChartManager) PullKafkaChart(version string) (*ChartInfo, error) {
	if version == "" || version == "latest" {
		var err error
		version, err = cm.GetLatestVersion()
		if err != nil {
			return nil, fmt.Errorf("failed to get latest version: %w", err)
		}
	}

	return cm.getChart("kafka", version)
}

func (cm *ChartManager) getChart(name, version string) (*ChartInfo, error) {
	chartName := fmt.Sprintf("%s-%s.tgz", name, version)
	chartPath := filepath.Join(cm.cacheDir, chartName)

	if _, err := os.Stat(chartPath); err == nil {
		if cm.verbose {
			fmt.Printf("📦 Using cached %s chart: %s\n", name, chartPath)
		}
		return &ChartInfo{
			Name:       name,
			Version:    version,
			Downloaded: false,
			CachedPath: chartPath,
		}, nil
	}

	if cm.verbose {
		fmt.Printf("📥 Downloading %s chart version %s...\n", name, version)
	}

	chartURL := fmt.Sprintf("%s/v%s/%s", cm.baseURL, version, chartName)
	checksumURL := fmt.Sprintf("%s.sha256", chartURL)

	checksum, err := cm.downloadChecksum(checksumURL)
	if err != nil {
		return nil, fmt.Errorf("failed to download checksum: %w", err)
	}

	if err := cm.downloadFile(chartURL, chartPath); err != nil {
		return nil, fmt.Errorf("failed to download chart: %w", err)
	}

	if err := cm.verifyChecksum(chartPath, checksum); err != nil {
		os.Remove(chartPath)
		return nil, fmt.Errorf("checksum verification failed: %w", err)
	}

	if cm.verbose {
		color.Green("✅ Chart downloaded and verified successfully")
	}

	return &ChartInfo{
		Name:       name,
		Version:    version,
		URL:        chartURL,
		SHA256:     checksum,
		Downloaded: true,
		CachedPath: chartPath,
	}, nil
}

type ReleaseInfo struct {
	Version     string
	ReleaseDate string
}

func (cm *ChartManager) GetLatestVersion() (string, error) {
	info, err := cm.GetLatestReleaseInfo()
	if err != nil {
		return "", err
	}
	return info.Version, nil
}

func (cm *ChartManager) GetLatestReleaseInfo() (*ReleaseInfo, error) {
	resp, err := cm.httpClient.Get("https://api.github.com/repos/rulebricks/charts/releases/latest")
	if err != nil {
		return nil, fmt.Errorf("failed to fetch latest release: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	reVersion := regexp.MustCompile(`"tag_name":\s*"v?([^"]+)"`)
	matchesVersion := reVersion.FindSubmatch(body)
	if len(matchesVersion) < 2 {
		return nil, fmt.Errorf("could not find version in GitHub response")
	}

	reDate := regexp.MustCompile(`"published_at":\s*"([^"]+)"`)
	matchesDate := reDate.FindSubmatch(body)

	info := &ReleaseInfo{
		Version: string(matchesVersion[1]),
	}

	if len(matchesDate) >= 2 {
		publishedAt, err := time.Parse(time.RFC3339, string(matchesDate[1]))
		if err == nil {
			info.ReleaseDate = publishedAt.Format("2006-01-02")
		}
	}

	return info, nil
}

func (cm *ChartManager) ExtractChart(chartPath string) (string, error) {
	tempDir, err := os.MkdirTemp("", "rulebricks-chart-*")
	if err != nil {
		return "", err
	}

	file, err := os.Open(chartPath)
	if err != nil {
		return "", err
	}
	defer file.Close()

	gzr, err := gzip.NewReader(file)
	if err != nil {
		return "", err
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)

	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}

		target := filepath.Join(tempDir, header.Name)

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0755); err != nil {
				return "", err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return "", err
			}

			outFile, err := os.Create(target)
			if err != nil {
				return "", err
			}

			if _, err := io.Copy(outFile, tr); err != nil {
				outFile.Close()
				return "", err
			}
			outFile.Close()

			if err := os.Chmod(target, os.FileMode(header.Mode)); err != nil {
				return "", err
			}
		}
	}

	return tempDir, nil
}

func (cm *ChartManager) ListCachedVersions() ([]string, error) {
	return cm.listCachedVersionsByName("rulebricks")
}

func (cm *ChartManager) listCachedVersionsByName(name string) ([]string, error) {
	entries, err := os.ReadDir(cm.cacheDir)
	if err != nil {
		return nil, err
	}

	var versions []string
	re := regexp.MustCompile(fmt.Sprintf(`^%s-(.+)\.tgz$`, name))

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		matches := re.FindStringSubmatch(entry.Name())
		if len(matches) == 2 {
			versions = append(versions, matches[1])
		}
	}

	return versions, nil
}

func (cm *ChartManager) CleanCache(keepVersions int) error {
	versions, err := cm.ListCachedVersions()
	if err != nil {
		return err
	}

	if len(versions) <= keepVersions {
		return nil
	}

	for i := 0; i < len(versions)-keepVersions; i++ {
		chartPath := filepath.Join(cm.cacheDir, fmt.Sprintf("rulebricks-%s.tgz", versions[i]))
		if err := os.Remove(chartPath); err != nil {
			color.Yellow("Failed to remove %s: %v", chartPath, err)
		} else if cm.verbose {
			fmt.Printf("🧹 Removed old chart: %s\n", chartPath)
		}
	}

	return nil
}

func (cm *ChartManager) downloadFile(url, dest string) error {
	resp, err := cm.httpClient.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed with status %d", resp.StatusCode)
	}

	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()

	if cm.verbose {
		return cm.copyWithProgress(out, resp.Body, resp.ContentLength)
	}

	_, err = io.Copy(out, resp.Body)
	return err
}

func (cm *ChartManager) downloadChecksum(url string) (string, error) {
	resp, err := cm.httpClient.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("checksum download failed with status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	parts := strings.Fields(string(body))
	if len(parts) < 1 {
		return "", fmt.Errorf("invalid checksum format")
	}

	return parts[0], nil
}

func (cm *ChartManager) verifyChecksum(filepath, expectedChecksum string) error {
	file, err := os.Open(filepath)
	if err != nil {
		return err
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}

	actualChecksum := hex.EncodeToString(hash.Sum(nil))
	if actualChecksum != expectedChecksum {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedChecksum, actualChecksum)
	}

	return nil
}

func (cm *ChartManager) copyWithProgress(dst io.Writer, src io.Reader, total int64) error {
	buffer := make([]byte, 32*1024)
	var written int64

	for {
		nr, er := src.Read(buffer)
		if nr > 0 {
			nw, ew := dst.Write(buffer[0:nr])
			if nw > 0 {
				written += int64(nw)
			}
			if ew != nil {
				return ew
			}
			if nr != nw {
				return io.ErrShortWrite
			}

			if total > 0 {
				percent := float64(written) / float64(total) * 100
				fmt.Printf("\r📊 Progress: %.1f%% (%s/%s)",
					percent,
					formatBytes(written),
					formatBytes(total))
			}
		}
		if er != nil {
			if er != io.EOF {
				return er
			}
			break
		}
	}

	if total > 0 {
		fmt.Println()
	}

	return nil
}
