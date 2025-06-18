// utils.go - Utility functions
package main

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"math/big"
	"time"
	"github.com/golang-jwt/jwt/v5"
)

// generateRandomString creates a cryptographically secure random string
func generateRandomString(length int) string {
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, length)
	charsetLen := big.NewInt(int64(len(charset)))

	for i := range b {
		n, err := rand.Int(rand.Reader, charsetLen)
		if err != nil {
			// Fallback to less secure but still reasonable randomness
			panic(fmt.Errorf("failed to generate random string: %w", err))
		}
		b[i] = charset[n.Int64()]
	}
	return string(b)
}

// generateJWT creates a JWT token for Supabase with the specified role
func generateJWT(role, secret string) string {
	// Supabase JWT claims structure
	claims := jwt.MapClaims{
		"role": role,
		"iss":  "supabase",
		"iat":  time.Now().Unix(),
		"exp":  time.Now().Add(10 * 365 * 24 * time.Hour).Unix(), // 10 years
	}

	// For anon role, add additional claims
	if role == "anon" {
		claims["aud"] = "authenticated"
	}

	// Create token with HS256 algorithm
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)

	// Sign with the secret
	tokenString, err := token.SignedString([]byte(secret))
	if err != nil {
		panic(fmt.Errorf("failed to generate JWT: %w", err))
	}

	return tokenString
}

// generateSecureToken creates a secure random token suitable for API keys
func generateSecureToken(length int) string {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		panic(fmt.Errorf("failed to generate secure token: %w", err))
	}
	return base64.URLEncoding.EncodeToString(bytes)
}

// generateDatabasePassword creates a strong database password
func generateDatabasePassword() string {
	// Use only alphanumeric characters to avoid URL encoding issues
	const (
		upperChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
		lowerChars = "abcdefghijklmnopqrstuvwxyz"
		digitChars = "0123456789"
	)

	// Ensure at least one character from each set
	password := ""
	password += getRandomChar(upperChars)
	password += getRandomChar(lowerChars)
	password += getRandomChar(digitChars)

	// Fill the rest randomly from all sets
	allChars := upperChars + lowerChars + digitChars
	remaining := 13 // Total length of 16
	for i := 0; i < remaining; i++ {
		password += getRandomChar(allChars)
	}

	// Shuffle the password
	return shuffleString(password)
}

// getRandomChar returns a random character from the given string
func getRandomChar(chars string) string {
	n, err := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
	if err != nil {
		panic(fmt.Errorf("failed to get random character: %w", err))
	}
	return string(chars[n.Int64()])
}

// shuffleString randomly shuffles the characters in a string
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

// validateEmail checks if an email address is valid
func validateEmail(email string) error {
	if email == "" {
		return fmt.Errorf("email address cannot be empty")
	}

	// Basic email validation - could be enhanced with regex
	atIndex := -1
	dotIndex := -1

	for i, ch := range email {
		if ch == '@' {
			if atIndex != -1 {
				return fmt.Errorf("email contains multiple @ symbols")
			}
			atIndex = i
		} else if ch == '.' && atIndex != -1 {
			dotIndex = i
		}
	}

	if atIndex == -1 {
		return fmt.Errorf("email missing @ symbol")
	}

	if atIndex == 0 || atIndex == len(email)-1 {
		return fmt.Errorf("email cannot start or end with @")
	}

	if dotIndex == -1 || dotIndex < atIndex+2 {
		return fmt.Errorf("email domain must contain a dot after @")
	}

	if dotIndex == len(email)-1 {
		return fmt.Errorf("email cannot end with a dot")
	}

	return nil
}

// sanitizeProjectName ensures project name is valid for Kubernetes resources
func sanitizeProjectName(name string) string {
	// Convert to lowercase
	sanitized := ""
	for _, ch := range name {
		if (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-' {
			sanitized += string(ch)
		} else if ch >= 'A' && ch <= 'Z' {
			sanitized += string(ch + 32) // Convert to lowercase
		} else if ch == '_' || ch == ' ' {
			sanitized += "-"
		}
	}

	// Ensure it doesn't start or end with hyphen
	for len(sanitized) > 0 && sanitized[0] == '-' {
		sanitized = sanitized[1:]
	}
	for len(sanitized) > 0 && sanitized[len(sanitized)-1] == '-' {
		sanitized = sanitized[:len(sanitized)-1]
	}

	// Ensure it's not empty and not too long
	if sanitized == "" {
		sanitized = "rulebricks"
	}
	if len(sanitized) > 63 {
		sanitized = sanitized[:63]
	}

	return sanitized
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

// parsePort validates and parses a port number
func parsePort(portStr string) (int, error) {
	if portStr == "" {
		return 0, fmt.Errorf("port cannot be empty")
	}

	port := 0
	for _, ch := range portStr {
		if ch < '0' || ch > '9' {
			return 0, fmt.Errorf("port must contain only digits")
		}
		port = port*10 + int(ch-'0')
		if port > 65535 {
			return 0, fmt.Errorf("port must be between 1 and 65535")
		}
	}

	if port < 1 {
		return 0, fmt.Errorf("port must be between 1 and 65535")
	}

	return port, nil
}

// isReservedPort checks if a port is in the reserved range
func isReservedPort(port int) bool {
	return port > 0 && port < 1024
}

// generateKubernetesName creates a valid Kubernetes resource name
func generateKubernetesName(base string, suffix string) string {
	name := sanitizeProjectName(base)
	if suffix != "" {
		name = fmt.Sprintf("%s-%s", name, suffix)
	}

	// Kubernetes names must be <= 63 characters
	if len(name) > 63 {
		// Truncate but keep suffix if possible
		if suffix != "" && len(suffix) < 20 {
			maxBase := 62 - len(suffix)
			name = fmt.Sprintf("%s-%s", name[:maxBase], suffix)
		} else {
			name = name[:63]
		}
	}

	return name
}

// mergeStringMaps merges two string maps, with values from 'override' taking precedence
func mergeStringMaps(base, override map[string]string) map[string]string {
	result := make(map[string]string)

	// Copy base values
	for k, v := range base {
		result[k] = v
	}

	// Override with new values
	for k, v := range override {
		result[k] = v
	}

	return result
}

// stringSliceContains checks if a string slice contains a value
func stringSliceContains(slice []string, value string) bool {
	for _, item := range slice {
		if item == value {
			return true
		}
	}
	return false
}

// uniqueStringSlice returns a slice with duplicate values removed
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
