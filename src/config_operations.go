// config_operations.go - Configuration manipulation operations
package main

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"
)

// getConfigValue retrieves a configuration value using dot notation
func getConfigValue(config Config, key string) (string, error) {
	parts := strings.Split(key, ".")
	if len(parts) == 0 {
		return "", fmt.Errorf("empty configuration key")
	}

	// Use reflection to traverse the configuration
	v := reflect.ValueOf(config)

	for i, part := range parts {
		// Handle both struct fields and map access
		if v.Kind() == reflect.Map {
			mapKey := reflect.ValueOf(part)
			v = v.MapIndex(mapKey)
			if !v.IsValid() {
				return "", fmt.Errorf("key not found: %s", strings.Join(parts[:i+1], "."))
			}
		} else if v.Kind() == reflect.Struct {
			// Find field by name (case-insensitive for YAML compatibility)
			fieldFound := false
			for j := 0; j < v.NumField(); j++ {
				field := v.Type().Field(j)
				yamlTag := field.Tag.Get("yaml")
				yamlName := strings.Split(yamlTag, ",")[0]

				if strings.EqualFold(yamlName, part) || strings.EqualFold(field.Name, part) {
					v = v.Field(j)
					fieldFound = true
					break
				}
			}

			if !fieldFound {
				return "", fmt.Errorf("field not found: %s", part)
			}
		} else if v.Kind() == reflect.Ptr {
			if v.IsNil() {
				return "", fmt.Errorf("nil pointer at: %s", strings.Join(parts[:i], "."))
			}
			v = v.Elem()
			i-- // Retry with the same part
			continue
		} else if v.Kind() == reflect.Interface {
			v = v.Elem()
			i-- // Retry with the same part
			continue
		} else {
			return "", fmt.Errorf("cannot traverse into %s: not a struct or map", strings.Join(parts[:i], "."))
		}
	}

	// Convert final value to string
	return valueToString(v), nil
}

// setConfigValue sets a configuration value using dot notation
func setConfigValue(config *Config, key, value string) error {
	parts := strings.Split(key, ".")
	if len(parts) == 0 {
		return fmt.Errorf("empty configuration key")
	}

	// Use reflection to traverse and set the value
	v := reflect.ValueOf(config).Elem()

	for i := 0; i < len(parts)-1; i++ {
		part := parts[i]

		if v.Kind() == reflect.Struct {
			// Find field by name
			fieldFound := false
			for j := 0; j < v.NumField(); j++ {
				field := v.Type().Field(j)
				yamlTag := field.Tag.Get("yaml")
				yamlName := strings.Split(yamlTag, ",")[0]

				if strings.EqualFold(yamlName, part) || strings.EqualFold(field.Name, part) {
					v = v.Field(j)
					fieldFound = true
					break
				}
			}

			if !fieldFound {
				return fmt.Errorf("field not found: %s", part)
			}

			// Initialize nil pointers
			if v.Kind() == reflect.Ptr && v.IsNil() {
				v.Set(reflect.New(v.Type().Elem()))
			}

			// Dereference pointers
			if v.Kind() == reflect.Ptr {
				v = v.Elem()
			}
		} else if v.Kind() == reflect.Map {
			if v.IsNil() {
				// Initialize map if nil
				v.Set(reflect.MakeMap(v.Type()))
			}
			mapKey := reflect.ValueOf(part)
			mapValue := v.MapIndex(mapKey)
			if !mapValue.IsValid() {
				// Create new value for map
				mapValue = reflect.New(v.Type().Elem()).Elem()
				v.SetMapIndex(mapKey, mapValue)
			}
			v = mapValue
		} else {
			return fmt.Errorf("cannot traverse into %s: not a struct or map", strings.Join(parts[:i+1], "."))
		}
	}

	// Set the final value
	lastPart := parts[len(parts)-1]

	if v.Kind() == reflect.Struct {
		fieldFound := false
		for j := 0; j < v.NumField(); j++ {
			field := v.Type().Field(j)
			yamlTag := field.Tag.Get("yaml")
			yamlName := strings.Split(yamlTag, ",")[0]

			if strings.EqualFold(yamlName, lastPart) || strings.EqualFold(field.Name, lastPart) {
				fieldValue := v.Field(j)
				if !fieldValue.CanSet() {
					return fmt.Errorf("cannot set field: %s", lastPart)
				}

				if err := setFieldValue(fieldValue, value); err != nil {
					return fmt.Errorf("failed to set %s: %w", key, err)
				}
				fieldFound = true
				break
			}
		}

		if !fieldFound {
			return fmt.Errorf("field not found: %s", lastPart)
		}
	} else if v.Kind() == reflect.Map {
		if v.IsNil() {
			v.Set(reflect.MakeMap(v.Type()))
		}

		mapKey := reflect.ValueOf(lastPart)
		mapValue := reflect.New(v.Type().Elem()).Elem()
		if err := setFieldValue(mapValue, value); err != nil {
			return fmt.Errorf("failed to set %s: %w", key, err)
		}
		v.SetMapIndex(mapKey, mapValue)
	} else {
		return fmt.Errorf("cannot set value on %s: not a struct or map", strings.Join(parts[:len(parts)-1], "."))
	}

	return nil
}

// valueToString converts a reflect.Value to string representation
func valueToString(v reflect.Value) string {
	if !v.IsValid() {
		return ""
	}

	// Handle nil values
	if v.Kind() == reflect.Ptr || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return ""
		}
		v = v.Elem()
	}

	switch v.Kind() {
	case reflect.String:
		return v.String()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return strconv.FormatInt(v.Int(), 10)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return strconv.FormatUint(v.Uint(), 10)
	case reflect.Float32, reflect.Float64:
		return strconv.FormatFloat(v.Float(), 'f', -1, 64)
	case reflect.Bool:
		return strconv.FormatBool(v.Bool())
	case reflect.Slice, reflect.Array:
		// Return comma-separated list
		values := []string{}
		for i := 0; i < v.Len(); i++ {
			values = append(values, valueToString(v.Index(i)))
		}
		return strings.Join(values, ",")
	case reflect.Map:
		// Return JSON-like representation
		pairs := []string{}
		for _, key := range v.MapKeys() {
			keyStr := valueToString(key)
			valStr := valueToString(v.MapIndex(key))
			pairs = append(pairs, fmt.Sprintf("%s=%s", keyStr, valStr))
		}
		return "{" + strings.Join(pairs, ", ") + "}"
	case reflect.Struct:
		// Return a summary of the struct
		return fmt.Sprintf("<%s>", v.Type().Name())
	default:
		return fmt.Sprintf("%v", v.Interface())
	}
}

// setFieldValue sets a reflect.Value from a string
func setFieldValue(field reflect.Value, value string) error {
	// Handle pointers
	if field.Kind() == reflect.Ptr {
		if field.IsNil() {
			field.Set(reflect.New(field.Type().Elem()))
		}
		field = field.Elem()
	}

	switch field.Kind() {
	case reflect.String:
		field.SetString(value)

	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		intVal, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return fmt.Errorf("invalid integer value: %s", value)
		}
		field.SetInt(intVal)

	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		uintVal, err := strconv.ParseUint(value, 10, 64)
		if err != nil {
			return fmt.Errorf("invalid unsigned integer value: %s", value)
		}
		field.SetUint(uintVal)

	case reflect.Float32, reflect.Float64:
		floatVal, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return fmt.Errorf("invalid float value: %s", value)
		}
		field.SetFloat(floatVal)

	case reflect.Bool:
		boolVal, err := strconv.ParseBool(value)
		if err != nil {
			// Also accept yes/no, on/off
			switch strings.ToLower(value) {
			case "yes", "on", "enabled":
				boolVal = true
			case "no", "off", "disabled":
				boolVal = false
			default:
				return fmt.Errorf("invalid boolean value: %s", value)
			}
		}
		field.SetBool(boolVal)

	case reflect.Slice:
		// Handle comma-separated values
		if field.Type().Elem().Kind() == reflect.String {
			values := []string{}
			if value != "" {
				values = strings.Split(value, ",")
				// Trim spaces
				for i := range values {
					values[i] = strings.TrimSpace(values[i])
				}
			}
			field.Set(reflect.ValueOf(values))
		} else {
			return fmt.Errorf("unsupported slice type: %s", field.Type())
		}

	case reflect.Map:
		// Handle simple key=value,key=value format
		if field.Type().Key().Kind() == reflect.String && field.Type().Elem().Kind() == reflect.String {
			m := make(map[string]string)
			if value != "" && value != "{}" {
				// Remove braces if present
				value = strings.Trim(value, "{}")
				pairs := strings.Split(value, ",")
				for _, pair := range pairs {
					kv := strings.SplitN(strings.TrimSpace(pair), "=", 2)
					if len(kv) == 2 {
						m[strings.TrimSpace(kv[0])] = strings.TrimSpace(kv[1])
					}
				}
			}
			field.Set(reflect.ValueOf(m))
		} else {
			return fmt.Errorf("unsupported map type: %s", field.Type())
		}

	default:
		return fmt.Errorf("unsupported field type: %s", field.Kind())
	}

	return nil
}

// Common configuration keys for tab completion
var configKeys = []string{
	// Project
	"project.name",
	"project.domain",
	"project.email",
	"project.license",
	"project.version",
	"project.namespace",

	// Cloud
	"cloud.provider",
	"cloud.region",
	"cloud.aws.account_id",
	"cloud.aws.vpc_cidr",
	"cloud.aws.instance_type",
	"cloud.azure.subscription_id",
	"cloud.azure.resource_group",
	"cloud.azure.vm_size",
	"cloud.gcp.project_id",
	"cloud.gcp.zone",
	"cloud.gcp.machine_type",

	// Kubernetes
	"kubernetes.cluster_name",
	"kubernetes.node_count",
	"kubernetes.min_nodes",
	"kubernetes.max_nodes",
	"kubernetes.enable_autoscale",

	// Database
	"database.type",
	"database.provider",
	"database.supabase.project_name",
	"database.supabase.region",
	"database.external.host",
	"database.external.port",
	"database.external.database",
	"database.external.username",
	"database.external.password_from",
	"database.external.ssl_mode",
	"database.pooling.enabled",
	"database.pooling.max_size",
	"database.pooling.min_size",

	// Email
	"email.provider",
	"email.from",
	"email.from_name",
	"email.smtp.host",
	"email.smtp.port",
	"email.smtp.username",
	"email.smtp.password_from",
	"email.smtp.encryption",
	"email.api_key_from",

	// Security
	"security.tls.enabled",
	"security.tls.provider",
	"security.tls.acme_email",
	"security.network.rate_limiting",
	"security.network.waf_enabled",
	"security.secrets.provider",
	"security.secrets.encryption",

	// Monitoring
	"monitoring.enabled",
	"monitoring.provider",
	"monitoring.metrics.retention",
	"monitoring.metrics.interval",
	"monitoring.logs.level",
	"monitoring.logs.retention",

	// Advanced
	"advanced.terraform.backend",
	"advanced.backup.enabled",
	"advanced.backup.schedule",
	"advanced.backup.retention",
	"advanced.backup.provider",
}
