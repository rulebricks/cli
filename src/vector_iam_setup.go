package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/fatih/color"
)

// IAMSetup handles IAM configuration for Vector sinks
type IAMSetup struct {
	config         interface{}
	namespace      string
	clusterName    string
	verbose        bool
	nonInteractive bool
}

// NewIAMSetup creates a new IAM setup handler
func NewIAMSetup(config interface{}, namespace, clusterName string, verbose, nonInteractive bool) *IAMSetup {
	return &IAMSetup{
		config:         config,
		namespace:      namespace,
		clusterName:    clusterName,
		verbose:        verbose,
		nonInteractive: nonInteractive,
	}
}

// SetupS3 configures AWS IAM for S3 sink
func (s *IAMSetup) SetupS3(bucket, region string) error {
	fmt.Println("🔧 Setting up AWS S3 permissions...")

	// Get AWS account ID
	accountID, err := s.getAWSAccountID()
	if err != nil {
		return fmt.Errorf("failed to get AWS account ID: %w", err)
	}

	// Check if OIDC provider exists
	oidcExists, err := s.checkOIDCProvider()
	if err != nil {
		return fmt.Errorf("failed to check OIDC provider: %w", err)
	}

	if !oidcExists {
		fmt.Println("  ✓ Creating OIDC provider...")
		if err := s.createOIDCProvider(); err != nil {
			return fmt.Errorf("failed to create OIDC provider: %w", err)
		}
	}

	// Create IAM policy
	policyName := fmt.Sprintf("VectorS3Access-%s", bucket)
	policyArn := fmt.Sprintf("arn:aws:iam::%s:policy/%s", accountID, policyName)

	fmt.Printf("  ✓ Creating IAM policy: %s\n", policyName)
	if err := s.createS3Policy(policyName, bucket); err != nil {
		return fmt.Errorf("failed to create IAM policy: %w", err)
	}

	// Create service account with IRSA
	serviceAccountName := "vector-s3-access"
	fmt.Printf("  ✓ Creating service account: %s\n", serviceAccountName)
	if err := s.createIRSAServiceAccount(serviceAccountName, policyArn); err != nil {
		return fmt.Errorf("failed to create service account: %w", err)
	}

	// Update Vector configuration
	fmt.Println("  ✓ Updating Vector configuration...")
	if err := s.updateVectorServiceAccount(serviceAccountName); err != nil {
		return fmt.Errorf("failed to update Vector: %w", err)
	}

	// Verify access
	if !s.nonInteractive {
		fmt.Println("\n  ✓ Verifying S3 access...")
		if err := s.verifyS3Access(bucket); err != nil {
			color.Yellow("  ⚠️  Warning: Could not verify S3 access: %v", err)
		} else {
			color.Green("  ✅ S3 access verified successfully!")
		}
	}

	color.Green("\n✅ S3 logging configured successfully!")
	fmt.Printf("\nVector will write logs to: s3://%s\n", bucket)

	return nil
}

// SetupGCS configures GCP IAM for Cloud Storage sink
func (s *IAMSetup) SetupGCS(bucket, projectID string) error {
	fmt.Println("🔧 Setting up GCP Cloud Storage permissions...")

	// Check if Workload Identity is enabled
	wiEnabled, err := s.checkWorkloadIdentity(projectID)
	if err != nil {
		return fmt.Errorf("failed to check Workload Identity: %w", err)
	}

	if !wiEnabled && !s.nonInteractive {
		fmt.Println("\n⚠️  Workload Identity is not enabled on your cluster.")
		fmt.Println("Would you like to:")
		fmt.Println("  1. Enable Workload Identity (recommended)")
		fmt.Println("  2. Use Service Account JSON (less secure)")
		fmt.Print("\nChoice (1/2): ")

		var choice string
		fmt.Scanln(&choice)

		if choice == "1" {
			fmt.Println("  ✓ Enabling Workload Identity...")
			if err := s.enableWorkloadIdentity(projectID); err != nil {
				return fmt.Errorf("failed to enable Workload Identity: %w", err)
			}
		} else {
			return s.setupGCSWithJSON(bucket, projectID)
		}
	}

	// Create service account
	serviceAccountName := "vector-gcs-access"
	serviceAccountEmail := fmt.Sprintf("%s@%s.iam.gserviceaccount.com", serviceAccountName, projectID)

	fmt.Printf("  ✓ Creating service account: %s\n", serviceAccountName)
	if err := s.createGCPServiceAccount(serviceAccountName, projectID); err != nil {
		return fmt.Errorf("failed to create service account: %w", err)
	}

	// Grant storage permissions
	fmt.Println("  ✓ Granting storage permissions...")
	if err := s.grantGCSPermissions(serviceAccountEmail, bucket, projectID); err != nil {
		return fmt.Errorf("failed to grant permissions: %w", err)
	}

	// Bind to Kubernetes service account
	k8sServiceAccount := "vector-gcs-access"
	fmt.Printf("  ✓ Binding to Kubernetes service account: %s\n", k8sServiceAccount)
	if err := s.bindWorkloadIdentity(serviceAccountEmail, k8sServiceAccount, projectID); err != nil {
		return fmt.Errorf("failed to bind Workload Identity: %w", err)
	}

	// Create Kubernetes service account
	if err := s.createK8sServiceAccount(k8sServiceAccount, serviceAccountEmail); err != nil {
		return fmt.Errorf("failed to create Kubernetes service account: %w", err)
	}

	// Update Vector configuration
	fmt.Println("  ✓ Updating Vector configuration...")
	if err := s.updateVectorServiceAccount(k8sServiceAccount); err != nil {
		return fmt.Errorf("failed to update Vector: %w", err)
	}

	// Verify access
	if !s.nonInteractive {
		fmt.Println("\n  ✓ Verifying GCS access...")
		if err := s.verifyGCSAccess(bucket); err != nil {
			color.Yellow("  ⚠️  Warning: Could not verify GCS access: %v", err)
		} else {
			color.Green("  ✅ GCS access verified successfully!")
		}
	}

	color.Green("\n✅ GCS logging configured successfully!")
	fmt.Printf("\nVector will write logs to: gs://%s\n", bucket)

	return nil
}

// SetupAzure configures Azure IAM for Blob Storage sink
func (s *IAMSetup) SetupAzure(storageAccount, container, resourceGroup string) error {
	fmt.Println("🔧 Setting up Azure Blob Storage permissions...")

	// Check if Pod Identity is available
	podIdentityAvailable, err := s.checkPodIdentity()
	if err != nil {
		return fmt.Errorf("failed to check Pod Identity: %w", err)
	}

	if !podIdentityAvailable && !s.nonInteractive {
		fmt.Println("\n⚠️  Pod Identity is not available on your cluster.")
		fmt.Println("Would you like to:")
		fmt.Println("  1. Use Managed Identity (recommended)")
		fmt.Println("  2. Use Connection String")
		fmt.Print("\nChoice (1/2): ")

		var choice string
		fmt.Scanln(&choice)

		if choice == "2" {
			return s.setupAzureWithConnectionString(storageAccount, container)
		}
	}

	// Create managed identity
	identityName := "vector-blob-access"
	fmt.Printf("  ✓ Creating managed identity: %s\n", identityName)
	identityID, err := s.createManagedIdentity(identityName, resourceGroup)
	if err != nil {
		return fmt.Errorf("failed to create managed identity: %w", err)
	}

	// Get subscription ID
	subscriptionID, err := s.getAzureSubscriptionID()
	if err != nil {
		return fmt.Errorf("failed to get subscription ID: %w", err)
	}

	// Assign storage permissions
	fmt.Println("  ✓ Assigning storage permissions...")
	scope := fmt.Sprintf("/subscriptions/%s/resourceGroups/%s/providers/Microsoft.Storage/storageAccounts/%s",
		subscriptionID, resourceGroup, storageAccount)
	if err := s.assignAzureRole(identityID, "Storage Blob Data Contributor", scope); err != nil {
		return fmt.Errorf("failed to assign role: %w", err)
	}

	// Configure pod identity
	fmt.Println("  ✓ Configuring pod identity...")
	if err := s.configurePodIdentity(identityName, identityID, resourceGroup); err != nil {
		return fmt.Errorf("failed to configure pod identity: %w", err)
	}

	// Update Vector configuration
	fmt.Println("  ✓ Updating Vector configuration...")
	if err := s.updateVectorPodIdentity(identityName); err != nil {
		return fmt.Errorf("failed to update Vector: %w", err)
	}

	// Verify access
	if !s.nonInteractive {
		fmt.Println("\n  ✓ Verifying Azure Blob access...")
		if err := s.verifyAzureAccess(storageAccount, container); err != nil {
			color.Yellow("  ⚠️  Warning: Could not verify Azure access: %v", err)
		} else {
			color.Green("  ✅ Azure Blob access verified successfully!")
		}
	}

	color.Green("\n✅ Azure Blob logging configured successfully!")
	fmt.Printf("\nVector will write logs to: https://%s.blob.core.windows.net/%s\n", storageAccount, container)

	return nil
}

// AWS helper methods
func (s *IAMSetup) getAWSAccountID() (string, error) {
	cmd := exec.Command("aws", "sts", "get-caller-identity", "--query", "Account", "--output", "text")
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func (s *IAMSetup) checkOIDCProvider() (bool, error) {
	cmd := exec.Command("eksctl", "utils", "describe-stacks", "--cluster", s.clusterName)
	output, err := cmd.Output()
	if err != nil {
		return false, nil // Assume doesn't exist
	}
	return strings.Contains(string(output), "OIDCProvider"), nil
}

func (s *IAMSetup) createOIDCProvider() error {
	cmd := exec.Command("eksctl", "utils", "associate-iam-oidc-provider",
		"--cluster", s.clusterName, "--approve")
	if s.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}
	return cmd.Run()
}

func (s *IAMSetup) createS3Policy(policyName, bucket string) error {
	policy := map[string]interface{}{
		"Version": "2012-10-17",
		"Statement": []map[string]interface{}{
			{
				"Effect": "Allow",
				"Action": []string{
					"s3:PutObject",
					"s3:PutObjectAcl",
					"s3:GetObject",
					"s3:DeleteObject",
				},
				"Resource": fmt.Sprintf("arn:aws:s3:::%s/*", bucket),
			},
			{
				"Effect": "Allow",
				"Action": []string{
					"s3:ListBucket",
					"s3:GetBucketLocation",
				},
				"Resource": fmt.Sprintf("arn:aws:s3:::%s", bucket),
			},
		},
	}

	policyJSON, err := json.Marshal(policy)
	if err != nil {
		return err
	}

	// Check if policy exists
	checkCmd := exec.Command("aws", "iam", "get-policy", "--policy-arn",
		fmt.Sprintf("arn:aws:iam::%s:policy/%s", s.getAccountIDSync(), policyName))
	if err := checkCmd.Run(); err == nil {
		// Policy exists, update it
		versionCmd := exec.Command("aws", "iam", "create-policy-version",
			"--policy-arn", fmt.Sprintf("arn:aws:iam::%s:policy/%s", s.getAccountIDSync(), policyName),
			"--policy-document", string(policyJSON),
			"--set-as-default")
		return versionCmd.Run()
	}

	// Create new policy
	cmd := exec.Command("aws", "iam", "create-policy",
		"--policy-name", policyName,
		"--policy-document", string(policyJSON))
	return cmd.Run()
}

func (s *IAMSetup) createIRSAServiceAccount(name, policyArn string) error {
	cmd := exec.Command("eksctl", "create", "iamserviceaccount",
		"--cluster", s.clusterName,
		"--namespace", s.namespace,
		"--name", name,
		"--attach-policy-arn", policyArn,
		"--override-existing-serviceaccounts",
		"--approve")
	if s.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}
	return cmd.Run()
}

func (s *IAMSetup) getAccountIDSync() string {
	accountID, _ := s.getAWSAccountID()
	return accountID
}

// GCP helper methods
func (s *IAMSetup) checkWorkloadIdentity(projectID string) (bool, error) {
	cmd := exec.Command("gcloud", "container", "clusters", "describe", s.clusterName,
		"--project", projectID, "--format", "value(workloadIdentityConfig.workloadPool)")
	output, err := cmd.Output()
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(output)) != "", nil
}

func (s *IAMSetup) enableWorkloadIdentity(projectID string) error {
	cmd := exec.Command("gcloud", "container", "clusters", "update", s.clusterName,
		"--workload-pool", fmt.Sprintf("%s.svc.id.goog", projectID),
		"--project", projectID)
	if s.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}
	return cmd.Run()
}

func (s *IAMSetup) createGCPServiceAccount(name, projectID string) error {
	// Check if exists
	checkCmd := exec.Command("gcloud", "iam", "service-accounts", "describe",
		fmt.Sprintf("%s@%s.iam.gserviceaccount.com", name, projectID),
		"--project", projectID)
	if err := checkCmd.Run(); err == nil {
		return nil // Already exists
	}

	cmd := exec.Command("gcloud", "iam", "service-accounts", "create", name,
		"--display-name", "Vector GCS Access",
		"--project", projectID)
	return cmd.Run()
}

func (s *IAMSetup) grantGCSPermissions(serviceAccount, bucket, projectID string) error {
	cmd := exec.Command("gcloud", "projects", "add-iam-policy-binding", projectID,
		"--member", fmt.Sprintf("serviceAccount:%s", serviceAccount),
		"--role", "roles/storage.objectAdmin",
		"--condition", fmt.Sprintf("expression=resource.name.startsWith('projects/_/buckets/%s'),title=Bucket Scope", bucket))
	return cmd.Run()
}

func (s *IAMSetup) bindWorkloadIdentity(gcpSA, k8sSA, projectID string) error {
	cmd := exec.Command("gcloud", "iam", "service-accounts", "add-iam-policy-binding", gcpSA,
		"--role", "roles/iam.workloadIdentityUser",
		"--member", fmt.Sprintf("serviceAccount:%s.svc.id.goog[%s/%s]", projectID, s.namespace, k8sSA),
		"--project", projectID)
	return cmd.Run()
}

func (s *IAMSetup) createK8sServiceAccount(name, gcpSA string) error {
	// Create service account
	createCmd := exec.Command("kubectl", "create", "serviceaccount", name,
		"-n", s.namespace, "--dry-run=client", "-o", "yaml")
	yamlOutput, err := createCmd.Output()
	if err != nil {
		return err
	}

	// Annotate with GCP service account
	applyCmd := exec.Command("kubectl", "apply", "-f", "-")
	applyCmd.Stdin = strings.NewReader(string(yamlOutput))
	if err := applyCmd.Run(); err != nil {
		return err
	}

	// Add annotation
	annotateCmd := exec.Command("kubectl", "annotate", "serviceaccount", name,
		"-n", s.namespace,
		fmt.Sprintf("iam.gke.io/gcp-service-account=%s", gcpSA),
		"--overwrite")
	return annotateCmd.Run()
}

func (s *IAMSetup) setupGCSWithJSON(bucket, projectID string) error {
	fmt.Println("\n📝 Service Account JSON Setup")
	fmt.Println("1. Create a service account with storage permissions")
	fmt.Println("2. Download the JSON key file")
	fmt.Println("3. Create a Kubernetes secret with the key:")
	fmt.Printf("\n   kubectl create secret generic gcs-key -n %s --from-file=key.json=PATH_TO_KEY_FILE\n\n", s.namespace)

	if !s.nonInteractive {
		fmt.Print("Press Enter when ready to continue...")
		fmt.Scanln()
	}

	return nil
}

// Azure helper methods
func (s *IAMSetup) checkPodIdentity() (bool, error) {
	cmd := exec.Command("kubectl", "get", "crd", "azureidentities.aadpodidentity.k8s.io")
	err := cmd.Run()
	return err == nil, nil
}

func (s *IAMSetup) createManagedIdentity(name, resourceGroup string) (string, error) {
	cmd := exec.Command("az", "identity", "create",
		"--resource-group", resourceGroup,
		"--name", name,
		"--output", "json")
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}

	var result map[string]interface{}
	if err := json.Unmarshal(output, &result); err != nil {
		return "", err
	}

	return result["principalId"].(string), nil
}

func (s *IAMSetup) getAzureSubscriptionID() (string, error) {
	cmd := exec.Command("az", "account", "show", "--query", "id", "-o", "tsv")
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func (s *IAMSetup) assignAzureRole(identityID, role, scope string) error {
	cmd := exec.Command("az", "role", "assignment", "create",
		"--assignee", identityID,
		"--role", role,
		"--scope", scope)
	return cmd.Run()
}

func (s *IAMSetup) configurePodIdentity(name, identityID, resourceGroup string) error {
	subscriptionID, err := s.getAzureSubscriptionID()
	if err != nil {
		return err
	}

	identityResourceID := fmt.Sprintf("/subscriptions/%s/resourceGroups/%s/providers/Microsoft.ManagedIdentity/userAssignedIdentities/%s",
		subscriptionID, resourceGroup, name)

	cmd := exec.Command("az", "aks", "pod-identity", "add",
		"--resource-group", resourceGroup,
		"--cluster-name", s.clusterName,
		"--namespace", s.namespace,
		"--name", name,
		"--identity-resource-id", identityResourceID)
	return cmd.Run()
}

func (s *IAMSetup) setupAzureWithConnectionString(storageAccount, container string) error {
	fmt.Println("\n🔑 Connection String Setup")
	fmt.Println("1. Get your storage account connection string from Azure Portal")
	fmt.Println("2. Create a Kubernetes secret:")
	fmt.Printf("\n   kubectl create secret generic azure-storage -n %s --from-literal=connection-string='YOUR_CONNECTION_STRING'\n\n", s.namespace)

	if !s.nonInteractive {
		fmt.Print("Press Enter when ready to continue...")
		fmt.Scanln()
	}

	return nil
}

// Update methods
func (s *IAMSetup) updateVectorServiceAccount(serviceAccount string) error {
	// Patch Vector deployment to use the service account
	cmd := exec.Command("kubectl", "patch", "deployment", "vector",
		"-n", s.namespace,
		"--type", "json",
		"-p", fmt.Sprintf(`[{"op": "add", "path": "/spec/template/spec/serviceAccountName", "value": "%s"}]`, serviceAccount))
	return cmd.Run()
}

func (s *IAMSetup) updateVectorPodIdentity(identityName string) error {
	// Add pod identity label
	cmd := exec.Command("kubectl", "label", "deployment", "vector",
		"-n", s.namespace,
		fmt.Sprintf("aadpodidbinding=%s", identityName),
		"--overwrite")
	return cmd.Run()
}

// Verification methods
func (s *IAMSetup) verifyS3Access(bucket string) error {
	// Get a Vector pod
	podName, err := s.getVectorPod()
	if err != nil {
		return err
	}

	// Test S3 access
	cmd := exec.Command("kubectl", "exec", podName, "-n", s.namespace, "--",
		"aws", "s3", "ls", fmt.Sprintf("s3://%s", bucket))
	return cmd.Run()
}

func (s *IAMSetup) verifyGCSAccess(bucket string) error {
	podName, err := s.getVectorPod()
	if err != nil {
		return err
	}

	cmd := exec.Command("kubectl", "exec", podName, "-n", s.namespace, "--",
		"gsutil", "ls", fmt.Sprintf("gs://%s", bucket))
	return cmd.Run()
}

func (s *IAMSetup) verifyAzureAccess(storageAccount, container string) error {
	podName, err := s.getVectorPod()
	if err != nil {
		return err
	}

	cmd := exec.Command("kubectl", "exec", podName, "-n", s.namespace, "--",
		"az", "storage", "blob", "list",
		"--account-name", storageAccount,
		"--container-name", container,
		"--auth-mode", "login")
	return cmd.Run()
}

func (s *IAMSetup) getVectorPod() (string, error) {
	cmd := exec.Command("kubectl", "get", "pods", "-n", s.namespace,
		"-l", "app.kubernetes.io/name=vector",
		"-o", "jsonpath={.items[0].metadata.name}")
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

// GenerateIAMConfig generates IAM configuration for manual setup
func (s *IAMSetup) GenerateIAMConfig(sinkType, bucket string) error {
	switch sinkType {
	case "aws_s3":
		return s.generateS3Config(bucket)
	case "gcp_cloud_storage":
		return s.generateGCSConfig(bucket)
	case "azure_blob":
		return s.generateAzureConfig(bucket)
	default:
		return fmt.Errorf("unsupported sink type: %s", sinkType)
	}
}

func (s *IAMSetup) generateS3Config(bucket string) error {
	accountID, _ := s.getAWSAccountID()

	policy := map[string]interface{}{
		"Version": "2012-10-17",
		"Statement": []map[string]interface{}{
			{
				"Effect": "Allow",
				"Action": []string{
					"s3:PutObject",
					"s3:PutObjectAcl",
					"s3:GetObject",
					"s3:DeleteObject",
				},
				"Resource": fmt.Sprintf("arn:aws:s3:::%s/*", bucket),
			},
			{
				"Effect": "Allow",
				"Action": []string{
					"s3:ListBucket",
					"s3:GetBucketLocation",
				},
				"Resource": fmt.Sprintf("arn:aws:s3:::%s", bucket),
			},
		},
	}

	policyJSON, _ := json.MarshalIndent(policy, "", "  ")

	fmt.Println("\n📋 AWS S3 IAM Configuration")
	fmt.Println("\n1. Save this IAM policy:")
	fmt.Println(string(policyJSON))

	fmt.Printf("\n2. Create the policy:\n")
	fmt.Printf("   aws iam create-policy --policy-name VectorS3Access-%s --policy-document file://policy.json\n", bucket)

	fmt.Printf("\n3. Create OIDC provider (if not exists):\n")
	fmt.Printf("   eksctl utils associate-iam-oidc-provider --cluster=%s --approve\n", s.clusterName)

	fmt.Printf("\n4. Create service account with IRSA:\n")
	fmt.Printf("   eksctl create iamserviceaccount \\\n")
	fmt.Printf("     --cluster=%s \\\n", s.clusterName)
	fmt.Printf("     --namespace=%s \\\n", s.namespace)
	fmt.Printf("     --name=vector-s3-access \\\n")
	fmt.Printf("     --attach-policy-arn=arn:aws:iam::%s:policy/VectorS3Access-%s \\\n", accountID, bucket)
	fmt.Printf("     --approve\n")

	fmt.Printf("\n5. Update Vector deployment:\n")
	fmt.Printf("   kubectl patch deployment vector -n %s --type=json -p '[{\"op\": \"add\", \"path\": \"/spec/template/spec/serviceAccountName\", \"value\": \"vector-s3-access\"}]'\n", s.namespace)

	return nil
}

func (s *IAMSetup) generateGCSConfig(bucket string) error {
	fmt.Println("\n📋 GCP Cloud Storage IAM Configuration")
	fmt.Println("\n1. Enable Workload Identity:")
	fmt.Printf("   gcloud container clusters update %s --workload-pool=PROJECT_ID.svc.id.goog\n", s.clusterName)

	fmt.Println("\n2. Create service account:")
	fmt.Println("   gcloud iam service-accounts create vector-gcs-access --display-name=\"Vector GCS Access\"")

	fmt.Println("\n3. Grant storage permissions:")
	fmt.Printf("   gcloud projects add-iam-policy-binding PROJECT_ID \\\n")
	fmt.Printf("     --member=\"serviceAccount:vector-gcs-access@PROJECT_ID.iam.gserviceaccount.com\" \\\n")
	fmt.Printf("     --role=\"roles/storage.objectAdmin\" \\\n")
	fmt.Printf("     --condition=\"expression=resource.name.startsWith('projects/_/buckets/%s'),title=Bucket Scope\"\n", bucket)

	fmt.Println("\n4. Bind to Kubernetes service account:")
	fmt.Printf("   gcloud iam service-accounts add-iam-policy-binding \\\n")
	fmt.Printf("     vector-gcs-access@PROJECT_ID.iam.gserviceaccount.com \\\n")
	fmt.Printf("     --role roles/iam.workloadIdentityUser \\\n")
	fmt.Printf("     --member \"serviceAccount:PROJECT_ID.svc.id.goog[%s/vector-gcs-access]\"\n", s.namespace)

	fmt.Println("\n5. Create and annotate Kubernetes service account:")
	fmt.Printf("   kubectl create serviceaccount vector-gcs-access -n %s\n", s.namespace)
	fmt.Printf("   kubectl annotate serviceaccount vector-gcs-access -n %s \\\n", s.namespace)
	fmt.Printf("     iam.gke.io/gcp-service-account=vector-gcs-access@PROJECT_ID.iam.gserviceaccount.com\n")

	fmt.Printf("\n6. Update Vector deployment:\n")
	fmt.Printf("   kubectl patch deployment vector -n %s --type=json -p '[{\"op\": \"add\", \"path\": \"/spec/template/spec/serviceAccountName\", \"value\": \"vector-gcs-access\"}]'\n", s.namespace)

	return nil
}

func (s *IAMSetup) generateAzureConfig(bucket string) error {
	fmt.Println("\n📋 Azure Blob Storage IAM Configuration")
	fmt.Println("\n1. Create managed identity:")
	fmt.Println("   az identity create --resource-group RESOURCE_GROUP --name vector-blob-access")

	fmt.Println("\n2. Get identity details:")
	fmt.Println("   IDENTITY_ID=$(az identity show --resource-group RESOURCE_GROUP --name vector-blob-access --query principalId -o tsv)")

	fmt.Println("\n3. Assign storage role:")
	fmt.Printf("   az role assignment create \\\n")
	fmt.Printf("     --assignee $IDENTITY_ID \\\n")
	fmt.Printf("     --role \"Storage Blob Data Contributor\" \\\n")
	fmt.Printf("     --scope \"/subscriptions/SUBSCRIPTION_ID/resourceGroups/RESOURCE_GROUP/providers/Microsoft.Storage/storageAccounts/STORAGE_ACCOUNT\"\n")

	fmt.Println("\n4. Configure pod identity:")
	fmt.Printf("   az aks pod-identity add \\\n")
	fmt.Printf("     --resource-group RESOURCE_GROUP \\\n")
	fmt.Printf("     --cluster-name %s \\\n", s.clusterName)
	fmt.Printf("     --namespace %s \\\n", s.namespace)
	fmt.Printf("     --name vector-blob-access \\\n")
	fmt.Printf("     --identity-resource-id /subscriptions/SUBSCRIPTION_ID/resourceGroups/RESOURCE_GROUP/providers/Microsoft.ManagedIdentity/userAssignedIdentities/vector-blob-access\n")

	fmt.Printf("\n5. Update Vector deployment:\n")
	fmt.Printf("   kubectl label deployment vector -n %s aadpodidbinding=vector-blob-access --overwrite\n", s.namespace)

	fmt.Println("\n⚠️  Replace SUBSCRIPTION_ID, RESOURCE_GROUP, and STORAGE_ACCOUNT with your actual values")

	return nil
}
