#!/bin/bash
#
# QPS Benchmark Test Runner
# Runs the QPS test and opens the HTML report in your browser
#
# Usage: ./run-qps-test.sh -u <API_URL> -k <API_KEY> [options]
#
# Options:
#   -u, --url        API URL (required)
#   -k, --key        API key (required)
#   -d, --duration   Measurement duration after 1m warm-up (default: 4m)
#   -r, --rps        Target RPS (default: 500)
#   -n, --no-open    Don't open report in browser
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

# Defaults
DURATION="4m"
RPS="500"
OPEN_REPORT=true

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -u|--url)
      API_URL="$2"
      shift 2
      ;;
    -k|--key)
      API_KEY="$2"
      shift 2
      ;;
    -d|--duration)
      DURATION="$2"
      shift 2
      ;;
    -r|--rps)
      RPS="$2"
      shift 2
      ;;
    -n|--no-open)
      OPEN_REPORT=false
      shift
      ;;
    -h|--help)
      echo "Usage: ./run-qps-test.sh -u <API_URL> -k <API_KEY> [options]"
      echo ""
      echo "Options:"
      echo "  -u, --url        API URL (required)"
      echo "  -k, --key        API key (required)"
      echo "  -d, --duration   Test duration (default: 2m)"
      echo "  -r, --rps        Target RPS (default: 500)"
      echo "  -n, --no-open    Don't open report in browser"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      exit 1
      ;;
  esac
done

# Validate required args
if [ -z "$API_URL" ]; then
  echo -e "${RED}Error: API_URL is required (-u)${NC}"
  exit 1
fi

if [ -z "$API_KEY" ]; then
  echo -e "${RED}Error: API_KEY is required (-k)${NC}"
  exit 1
fi

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${CYAN}Running QPS Benchmark...${NC}"
echo "  URL:      $API_URL"
echo "  Warm-up:  1m"
echo "  Duration: $DURATION (after warm-up)"
echo "  Target:   $RPS RPS"
echo ""

# Run k6 test
k6 run \
  -e API_URL="$API_URL" \
  -e API_KEY="$API_KEY" \
  -e TEST_DURATION="$DURATION" \
  -e TARGET_RPS="$RPS" \
  "$SCRIPT_DIR/qps-test.js" || true

# Open report in browser
if [ "$OPEN_REPORT" = true ] && [ -f "$SCRIPT_DIR/qps-report.html" ]; then
  echo ""
  echo -e "${GREEN}Opening report in browser...${NC}"
  
  # Cross-platform open command
  if command -v open &> /dev/null; then
    open "$SCRIPT_DIR/qps-report.html"
  elif command -v xdg-open &> /dev/null; then
    xdg-open "$SCRIPT_DIR/qps-report.html"
  elif command -v start &> /dev/null; then
    start "$SCRIPT_DIR/qps-report.html"
  else
    echo "Report saved to: $SCRIPT_DIR/qps-report.html"
  fi
fi

