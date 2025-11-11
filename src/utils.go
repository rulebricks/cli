package main

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// generateRandomString creates a cryptographically secure random strin
func generateRandomString(length int) string {
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, length)
	charsetLen := big.NewInt(int64(len(charset)))

	for i := range b {
		n, err := rand.Int(rand.Reader, charsetLen)
		if err != nil {
			panic(fmt.Errorf("failed to generate random string: %w", err))
		}
		b[i] = charset[n.Int64()]
	}
	return string(b)
}


func generateDatabasePassword() string {
	const (
		upperChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
		lowerChars = "abcdefghijklmnopqrstuvwxyz"
		digitChars = "0123456789"
	)

	password := ""
	password += getRandomChar(upperChars)
	password += getRandomChar(lowerChars)
	password += getRandomChar(digitChars)

	allChars := upperChars + lowerChars + digitChars
	remaining := 13
	for i := 0; i < remaining; i++ {
		password += getRandomChar(allChars)
	}

	return shuffleString(password)
}

func generateJWT(role, secret string) string {
	claims := jwt.MapClaims{
		"role": role,
		"iss":  "supabase",
		"iat":  time.Now().Unix(),
		"exp":  time.Now().Add(10 * 365 * 24 * time.Hour).Unix(),
	}

	if role == "anon" {
		claims["aud"] = "authenticated"
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)

	tokenString, err := token.SignedString([]byte(secret))
	if err != nil {
		panic(fmt.Errorf("failed to generate JWT: %w", err))
	}

	return tokenString
}

func getRandomChar(chars string) string {
	n, err := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
	if err != nil {
		panic(fmt.Errorf("failed to get random character: %w", err))
	}
	return string(chars[n.Int64()])
}

func shuffleString(s string) string {
	runes := []rune(s)
	n := len(runes)

	for i := n - 1; i > 0; i-- {
		j, err := rand.Int(rand.Reader, big.NewInt(int64(i+1)))
		if err != nil {
			panic(fmt.Errorf("failed to shuffle string: %w", err))
		}
		jInt := int(j.Int64())
		runes[i], runes[jInt] = runes[jInt], runes[i]
	}

	return string(runes)
}

func validateEmail(email string) error {
	if email == "" {
		return fmt.Errorf("email address cannot be empty")
	}

	emailRegex := regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)
	if !emailRegex.MatchString(email) {
		return fmt.Errorf("invalid email format")
	}

	return nil
}

// ensures project name is valid for Kubernetes resources
func sanitizeProjectName(name string) string {
	name = strings.ToLower(name)

	name = regexp.MustCompile(`[^a-z0-9\-]`).ReplaceAllString(name, "-")

	name = regexp.MustCompile(`-+`).ReplaceAllString(name, "-")

	name = strings.Trim(name, "-")

	if name == "" {
		name = DefaultProjectName
	}
	if len(name) > 63 {
		name = name[:63]
	}

	return name
}

// formatBytes converts bytes to human-readable format
func formatBytes(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}

	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}

	return fmt.Sprintf("%.1f %ciB", float64(bytes)/float64(div), "KMGTPE"[exp])
}


func isValidDomain(domain string) bool {
	if domain == "" || len(domain) > 253 {
		return false
	}

	domainRegex := regexp.MustCompile(`^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?$`)
	return domainRegex.MatchString(domain)
}


func stringSliceContains(slice []string, value string) bool {
	for _, item := range slice {
		if item == value {
			return true
		}
	}
	return false
}

func uniqueStringSlice(slice []string) []string {
	seen := make(map[string]bool)
	result := []string{}

	for _, value := range slice {
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}

	return result
}

func resolveSecretValue(source string) (string, error) {
	if strings.HasPrefix(source, "env:") {
		envVar := strings.TrimPrefix(source, "env:")
		if value := os.Getenv(envVar); value != "" {
			return value, nil
		}
		return "", fmt.Errorf("environment variable %s not set", envVar)
	} else if strings.HasPrefix(source, "file:") {
		filePath := strings.TrimPrefix(source, "file:")
		content, err := os.ReadFile(filePath)
		if err != nil {
			return "", fmt.Errorf("failed to read file %s: %w", filePath, err)
		}
		return strings.TrimSpace(string(content)), nil
	} else if strings.HasPrefix(source, "plain:") {
		return strings.TrimPrefix(source, "plain:"), nil
	}

	return source, nil
}

func createTempFile(prefix, suffix string, content []byte) (string, error) {
	tmpfile, err := os.CreateTemp("", prefix+"*"+suffix)
	if err != nil {
		return "", fmt.Errorf("failed to create temp file: %w", err)
	}

	if _, err := tmpfile.Write(content); err != nil {
		tmpfile.Close()
		os.Remove(tmpfile.Name())
		return "", fmt.Errorf("failed to write to temp file: %w", err)
	}

	if err := tmpfile.Close(); err != nil {
		os.Remove(tmpfile.Name())
		return "", fmt.Errorf("failed to close temp file: %w", err)
	}

	return tmpfile.Name(), nil
}

func sanitizeJWT(jwt string) string {
	ansiRegex := regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)
	cleanJWT := ansiRegex.ReplaceAllString(jwt, "")

	cleanJWT = strings.TrimSpace(cleanJWT)

	jwtRegex := regexp.MustCompile(`^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`)
	if !jwtRegex.MatchString(cleanJWT) {
		fmt.Fprintf(os.Stderr, "Warning: JWT may be corrupted after sanitization\n")
	}

	return cleanJWT
}
