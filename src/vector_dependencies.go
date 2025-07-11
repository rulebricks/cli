package main

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// Dependency represents a required CLI tool
type Dependency struct {
	Name       string
	Command    string
	InstallDoc string
	InstallCmd map[string]string // OS-specific install commands
}

// DependencyChecker checks for required CLI dependencies
type DependencyChecker struct {
	dependencies []Dependency
}

// NewDependencyChecker creates a new dependency checker for the specified provider
func NewDependencyChecker(provider string) *DependencyChecker {
	dc := &DependencyChecker{}

	// Common dependencies
	commonDeps := []Dependency{
		{
			Name:       "kubectl",
			Command:    "kubectl",
			InstallDoc: "https://kubernetes.io/docs/tasks/tools/",
			InstallCmd: map[string]string{
				"darwin": "brew install kubectl",
				"linux":  "curl -LO https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl && chmod +x kubectl && sudo mv kubectl /usr/local/bin/",
			},
		},
	}

	switch provider {
	case "aws", "s3":
		dc.dependencies = append(commonDeps, []Dependency{
			{
				Name:       "AWS CLI",
				Command:    "aws",
				InstallDoc: "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
				InstallCmd: map[string]string{
					"darwin": "brew install awscli",
					"linux":  "curl \"https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip\" -o \"awscliv2.zip\" && unzip awscliv2.zip && sudo ./aws/install",
				},
			},
			{
				Name:       "eksctl",
				Command:    "eksctl",
				InstallDoc: "https://eksctl.io/installation/",
				InstallCmd: map[string]string{
					"darwin": "brew tap weaveworks/tap && brew install weaveworks/tap/eksctl",
					"linux":  "curl --silent --location \"https://github.com/weaveworks/eksctl/releases/latest/download/eksctl_$(uname -s)_amd64.tar.gz\" | tar xz -C /tmp && sudo mv /tmp/eksctl /usr/local/bin",
				},
			},
		}...)

	case "gcp", "gcs":
		dc.dependencies = append(commonDeps, []Dependency{
			{
				Name:       "Google Cloud SDK",
				Command:    "gcloud",
				InstallDoc: "https://cloud.google.com/sdk/docs/install",
				InstallCmd: map[string]string{
					"darwin": "brew install --cask google-cloud-sdk",
					"linux":  "curl https://sdk.cloud.google.com | bash && exec -l $SHELL",
				},
			},
		}...)

	case "azure":
		dc.dependencies = append(commonDeps, []Dependency{
			{
				Name:       "Azure CLI",
				Command:    "az",
				InstallDoc: "https://docs.microsoft.com/en-us/cli/azure/install-azure-cli",
				InstallCmd: map[string]string{
					"darwin": "brew install azure-cli",
					"linux":  "curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash",
				},
			},
		}...)
	}

	return dc
}

// CheckDependencies verifies all required dependencies are installed
func (dc *DependencyChecker) CheckDependencies() error {
	var missing []string
	var missingDeps []Dependency

	for _, dep := range dc.dependencies {
		if _, err := exec.LookPath(dep.Command); err != nil {
			missing = append(missing, dep.Name)
			missingDeps = append(missingDeps, dep)
		}
	}

	if len(missing) > 0 {
		return dc.formatMissingDependencyError(missingDeps)
	}

	return nil
}

// formatMissingDependencyError creates a helpful error message with installation instructions
func (dc *DependencyChecker) formatMissingDependencyError(missingDeps []Dependency) error {
	var sb strings.Builder

	sb.WriteString("Missing required dependencies:\n\n")

	for _, dep := range missingDeps {
		sb.WriteString(fmt.Sprintf("❌ %s (%s)\n", dep.Name, dep.Command))
	}

	sb.WriteString("\nTo install the missing dependencies:\n\n")

	currentOS := runtime.GOOS
	for _, dep := range missingDeps {
		sb.WriteString(fmt.Sprintf("• %s:\n", dep.Name))

		if installCmd, ok := dep.InstallCmd[currentOS]; ok {
			sb.WriteString(fmt.Sprintf("  %s\n", installCmd))
		} else {
			sb.WriteString(fmt.Sprintf("  See: %s\n", dep.InstallDoc))
		}
		sb.WriteString("\n")
	}

	sb.WriteString("After installing the dependencies, please run the command again.")

	return fmt.Errorf("%s", sb.String())
}

// CheckSpecificDependency checks if a specific dependency is available
func (dc *DependencyChecker) CheckSpecificDependency(command string) error {
	for _, dep := range dc.dependencies {
		if dep.Command == command {
			if _, err := exec.LookPath(command); err != nil {
				return dc.formatMissingDependencyError([]Dependency{dep})
			}
			return nil
		}
	}
	return nil
}

// GetInstallInstructions returns installation instructions for a specific dependency
func (dc *DependencyChecker) GetInstallInstructions(command string) string {
	for _, dep := range dc.dependencies {
		if dep.Command == command {
			currentOS := runtime.GOOS
			if installCmd, ok := dep.InstallCmd[currentOS]; ok {
				return fmt.Sprintf("Install %s with: %s", dep.Name, installCmd)
			}
			return fmt.Sprintf("Install %s: %s", dep.Name, dep.InstallDoc)
		}
	}
	return ""
}
